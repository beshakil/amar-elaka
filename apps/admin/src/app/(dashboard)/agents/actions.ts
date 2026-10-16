'use server';

import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { apiErrorMessageKey } from '@/lib/api/error-messages';
import { apiFetch } from '@/lib/api/fetch';
import { createdIdSchema, noContentSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';

// Mirrors apps/api/src/agents/dto/agents.dto.ts so the page refuses what the API would.
const id = z.string().uuid();
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const targets = z
  .object({
    daily_shops: z.number().int().min(0).optional(),
    weekly_shops: z.number().int().min(0).optional(),
  })
  .strict();

const createAgent = z.object({
  memberId: id,
  agentCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{2,20}$/),
  employmentType: z.enum(['commission_only', 'salaried', 'volunteer']),
  commissionRate: money.nullable(),
  targets,
});
export type CreateAgentInput = z.infer<typeof createAgent>;

const updateAgent = z
  .object({
    status: z.enum(['active', 'suspended', 'terminated']),
    commissionRate: money.nullable(),
    targets,
  })
  .partial();
export type UpdateAgentInput = z.infer<typeof updateAgent>;

const createTask = z.object({
  type: z.enum(['map_shop', 'verify_shop', 'update_info']),
  title: z.string().trim().min(1),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  placeId: id.optional(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().min(1).optional(),
});
export type CreateTaskInput = z.infer<typeof createTask>;

async function call(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  schema: z.ZodTypeAny,
): Promise<ActionResult> {
  const session = await readSession();
  if (!session) return { ok: false, messageKey: 'unauthenticated' };
  try {
    await apiFetch({
      path,
      method,
      schema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
      ...(body === undefined ? {} : { body }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, messageKey: apiErrorMessageKey(error) };
  }
}

const invalid: ActionResult = { ok: false, messageKey: 'validationFailed' };

export async function addAgent(input: CreateAgentInput): Promise<ActionResult> {
  const parsed = createAgent.safeParse(input);
  if (!parsed.success) return invalid;
  return call('/agents', 'POST', parsed.data, createdIdSchema);
}

export async function changeAgent(agentId: string, input: UpdateAgentInput): Promise<ActionResult> {
  const parsed = updateAgent.safeParse(input);
  if (!parsed.success || !id.safeParse(agentId).success || Object.keys(parsed.data).length === 0) {
    return invalid;
  }
  return call(`/agents/${agentId}`, 'PATCH', parsed.data, noContentSchema);
}

export async function addTask(agentId: string, input: CreateTaskInput): Promise<ActionResult> {
  const parsed = createTask.safeParse(input);
  if (!parsed.success || !id.safeParse(agentId).success) return invalid;
  if (parsed.data.type !== 'map_shop' && !parsed.data.placeId) return invalid;
  return call(`/agents/${agentId}/tasks`, 'POST', parsed.data, createdIdSchema);
}

export async function setTaskStatus(
  taskId: string,
  status: 'open' | 'cancelled',
): Promise<ActionResult> {
  if (!id.safeParse(taskId).success || !['open', 'cancelled'].includes(status)) return invalid;
  return call(`/agents/tasks/${taskId}`, 'PATCH', { status }, noContentSchema);
}

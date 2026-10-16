import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { agentListSchema, agentTaskListSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { AGENT_ADMIN_ROLES } from '@/lib/nav/nav';
import { AgentsTabs } from '../agents-tabs';
import { TasksClient } from './tasks-client';

/** One agent's tasks (ADR 066): what to map, verify or update, where, by when. */
export default async function AgentTasksPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireRoles(AGENT_ADMIN_ROLES);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const auth = { tenantId: viewer.session.tenantId, accessToken: viewer.session.accessToken };
  const [list, tasks, t] = await Promise.all([
    apiFetch({ path: '/agents', schema: agentListSchema, ...auth }),
    apiFetch({ path: `/agents/${id}/tasks`, schema: agentTaskListSchema, ...auth }).catch(
      () => null,
    ),
    getTranslations('agents'),
  ]);
  const agent = list.items.find((a) => a.id === id);
  if (!agent || !tasks) notFound();
  return (
    <>
      <AgentsTabs active="agents" />
      <h1 className="mb-1 text-xl font-semibold">
        {t('tasksTitle', { name: agent.name ?? agent.code })}
      </h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('tasksDescription')}</p>
      <TasksClient agentId={id} tasks={tasks.items} today={list.date} />
    </>
  );
}

import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { agentListSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { AGENT_ADMIN_ROLES } from '@/lib/nav/nav';
import { AgentsTabs } from './agents-tabs';
import { AgentsClient } from './agents-client';

/**
 * The area's field agents (ADR 066): today's and this week's numbers,
 * approval rate and flagged submissions per agent; targets, rate and status;
 * adding a member with the agent role.
 */
export default async function AgentsPage() {
  const viewer = await requireRoles(AGENT_ADMIN_ROLES);
  const [list, t] = await Promise.all([
    apiFetch({
      path: '/agents',
      schema: agentListSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('agents'),
  ]);
  return (
    <>
      <AgentsTabs active="agents" />
      <h1 className="mb-1 text-xl font-semibold">{t('title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('description')}</p>
      <AgentsClient list={list} />
    </>
  );
}

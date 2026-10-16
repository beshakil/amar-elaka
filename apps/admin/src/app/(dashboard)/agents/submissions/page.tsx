import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { agentListSchema, agentSubmissionDaySchema, mapConfigSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { AGENT_ADMIN_ROLES } from '@/lib/nav/nav';
import { AgentsTabs } from '../agents-tabs';
import { SubmissionsClient } from './submissions-client';

/**
 * A day's submissions per agent (ADR 066): on the map, and as the review
 * list — a new shop is approved or rejected through the places review queue,
 * an update through the suggestions queue; flags show what to look at.
 */
export default async function AgentSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; agentId?: string }>;
}) {
  const viewer = await requireRoles(AGENT_ADMIN_ROLES);
  const { date, agentId } = await searchParams;
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  const agent = agentId && /^[0-9a-f-]{36}$/.test(agentId) ? agentId : undefined;
  const auth = { tenantId: viewer.session.tenantId, accessToken: viewer.session.accessToken };
  const [submissions, agents, config, t] = await Promise.all([
    apiFetch({
      path: '/agents/submissions',
      query: { ...(day ? { date: day } : {}), ...(agent ? { agentId: agent } : {}) },
      schema: agentSubmissionDaySchema,
      ...auth,
    }),
    apiFetch({ path: '/agents', schema: agentListSchema, ...auth }),
    apiFetch({ path: '/map/config', schema: mapConfigSchema, ...auth }).catch(() => null),
    getTranslations('agents'),
  ]);
  return (
    <>
      <AgentsTabs active="submissions" />
      <h1 className="mb-1 text-xl font-semibold">{t('submissionsTitle')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('submissionsDescription')}</p>
      <SubmissionsClient
        day={submissions}
        agents={agents.items.map((a) => ({ id: a.id, label: a.name ?? a.code }))}
        agentId={agent ?? null}
        config={config}
      />
    </>
  );
}

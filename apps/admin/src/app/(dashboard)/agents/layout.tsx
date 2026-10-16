import { requireRoles } from '@/lib/auth/guards';
import { AGENT_ADMIN_ROLES } from '@/lib/nav/nav';

/** Field agents (ADR 066): the area's staff. Changes are for its admins (the API checks). */
export default async function AgentsLayout({ children }: { children: React.ReactNode }) {
  await requireRoles(AGENT_ADMIN_ROLES);
  return children;
}

import { requireRoles } from '@/lib/auth/guards';
import { LOCAL_INFO_ROLES } from '@/lib/nav/nav';

/**
 * The area's local information (ADR 064): staff and field agents. Each page
 * narrows further where the API does (blood takedowns, the board's catalogue
 * and sponsor: staff only).
 */
export default async function LocalInfoLayout({ children }: { children: React.ReactNode }) {
  await requireRoles(LOCAL_INFO_ROLES);
  return children;
}

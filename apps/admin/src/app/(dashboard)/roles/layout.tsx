import { requireGrant } from '@/lib/auth/guards';

export default async function RolesLayout({ children }: { children: React.ReactNode }) {
  await requireGrant({ module: 'roles', action: 'read' });
  return children;
}

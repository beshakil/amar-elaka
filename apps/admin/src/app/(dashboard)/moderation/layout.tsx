import { requireGrant } from '@/lib/auth/guards';

export default async function ModerationLayout({ children }: { children: React.ReactNode }) {
  await requireGrant({ module: 'posts', action: 'approve' });
  return children;
}

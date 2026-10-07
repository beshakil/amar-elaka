import { notFound } from 'next/navigation';
import { currentViewer, hasGrant } from '@/lib/auth/me';

/**
 * Moderating posts or places opens this section; each page then checks its
 * own grant (posts:approve for /moderation, places:approve for /places).
 */
export default async function ModerationLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();
  const allowed =
    hasGrant(viewer.permissions, { module: 'posts', action: 'approve' }) ||
    hasGrant(viewer.permissions, { module: 'places', action: 'approve' });
  if (!allowed) notFound();
  return children;
}

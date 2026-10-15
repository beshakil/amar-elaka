import { notFound } from 'next/navigation';
import { currentViewer, hasGrant } from '@/lib/auth/me';
import { MODERATION_TABS } from './moderation-tabs';

/**
 * Any moderation grant opens this section; each page then checks its own
 * (posts:approve for /moderation, complaints:read for /complaints, …).
 */
export default async function ModerationLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();
  if (!MODERATION_TABS.some((tab) => hasGrant(viewer.permissions, tab.grant))) notFound();
  return children;
}

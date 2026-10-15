import type { Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { currentViewer, hasGrant } from '@/lib/auth/me';
import { cn } from '@/lib/utils';

/**
 * Every moderation queue, each tab only for those who may work it: posts,
 * places, verifications (ADR 062), complaints, bans, appeals and the
 * blacklist recommendations (ADR 063).
 */
export const MODERATION_TABS = [
  { key: 'posts', href: '/moderation', grant: { module: 'posts', action: 'approve' } },
  { key: 'places', href: '/moderation/places', grant: { module: 'places', action: 'approve' } },
  {
    key: 'verifications',
    href: '/moderation/verifications',
    grant: { module: 'verifications', action: 'approve' },
  },
  {
    key: 'complaints',
    href: '/moderation/complaints',
    grant: { module: 'complaints', action: 'read' },
  },
  { key: 'bans', href: '/moderation/bans', grant: { module: 'bans', action: 'read' } },
  { key: 'appeals', href: '/moderation/appeals', grant: { module: 'appeals', action: 'read' } },
  {
    key: 'blacklist',
    href: '/moderation/blacklist',
    grant: { module: 'blacklist', action: 'read' },
  },
] as const;
export type ModerationTab = (typeof MODERATION_TABS)[number]['key'];

export async function ModerationTabs({ active }: { active: ModerationTab }) {
  const t = await getTranslations('moderation');
  const viewer = await currentViewer();
  const visible = MODERATION_TABS.filter((tab) => hasGrant(viewer.permissions, tab.grant));
  if (visible.length < 2) return null;
  return (
    <nav aria-label={t('tabs')} className="mb-4 flex flex-wrap gap-1 border-b">
      {visible.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href as Route}
          aria-current={tab.key === active ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-4 py-2 text-sm font-medium',
            tab.key === active
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t(`tab.${tab.key}`)}
        </Link>
      ))}
    </nav>
  );
}

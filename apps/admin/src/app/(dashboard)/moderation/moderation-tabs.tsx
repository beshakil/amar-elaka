import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { currentViewer, hasGrant } from '@/lib/auth/me';
import { cn } from '@/lib/utils';

/** Posts | Places: each tab only for those who may moderate it. */
export async function ModerationTabs({ active }: { active: 'posts' | 'places' }) {
  const t = await getTranslations('moderation');
  const viewer = await currentViewer();
  const tabs = [
    { key: 'posts', href: '/moderation', grant: { module: 'posts', action: 'approve' } },
    { key: 'places', href: '/moderation/places', grant: { module: 'places', action: 'approve' } },
  ] as const;
  const visible = tabs.filter((tab) => hasGrant(viewer.permissions, tab.grant));
  if (visible.length < 2) return null;
  return (
    <nav aria-label={t('tabs')} className="mb-4 flex gap-1 border-b">
      {visible.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
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

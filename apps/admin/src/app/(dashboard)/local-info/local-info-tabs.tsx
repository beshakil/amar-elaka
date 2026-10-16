import type { Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { currentViewer } from '@/lib/auth/me';
import { LOCAL_INFO_STAFF_ROLES } from '@/lib/nav/nav';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'emergency', href: '/local-info', staffOnly: false },
  { key: 'bazar', href: '/local-info/bazar', staffOnly: false },
  { key: 'blood', href: '/local-info/blood', staffOnly: true },
  // The info engine (ADR 065).
  { key: 'outages', href: '/local-info/outages', staffOnly: false },
  { key: 'transport', href: '/local-info/transport', staffOnly: false },
  { key: 'notices', href: '/local-info/notices', staffOnly: false },
  { key: 'gov', href: '/local-info/gov', staffOnly: false },
  { key: 'moderation', href: '/local-info/moderation', staffOnly: true },
] as const;

export async function LocalInfoTabs({ active }: { active: (typeof TABS)[number]['key'] }) {
  const t = await getTranslations('localInfo');
  const viewer = await currentViewer();
  const staff = (LOCAL_INFO_STAFF_ROLES as readonly string[]).includes(
    viewer.permissions.role ?? '',
  );
  return (
    // Scrolls sideways on a phone rather than wrapping into a wall of tabs.
    <nav aria-label={t('tabs')} className="mb-4 flex gap-1 overflow-x-auto border-b">
      {TABS.filter((tab) => staff || !tab.staffOnly).map((tab) => (
        <Link
          key={tab.key}
          href={tab.href as Route}
          aria-current={tab.key === active ? 'page' : undefined}
          className={cn(
            '-mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium',
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

export async function isLocalInfoStaff(): Promise<boolean> {
  const viewer = await currentViewer();
  return (LOCAL_INFO_STAFF_ROLES as readonly string[]).includes(viewer.permissions.role ?? '');
}

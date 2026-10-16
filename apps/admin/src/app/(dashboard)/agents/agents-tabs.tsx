import type { Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'agents', href: '/agents' },
  { key: 'submissions', href: '/agents/submissions' },
  { key: 'commissions', href: '/agents/commissions' },
] as const;

export async function AgentsTabs({ active }: { active: (typeof TABS)[number]['key'] }) {
  const t = await getTranslations('agents');
  return (
    <nav aria-label={t('tabs')} className="mb-4 flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => (
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

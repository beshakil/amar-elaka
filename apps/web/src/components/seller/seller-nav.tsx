'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

const TABS = [
  ['dashboard', ''],
  ['products', '/products'],
  ['import', '/import'],
  ['catalog', '/catalog'],
] as const;

/** The panel's sections; the current one marked for screen readers too. */
export function SellerNav({ storeId }: { storeId: string }) {
  const t = useTranslations('seller.nav');
  const pathname = usePathname();
  const base = `/seller/${storeId}`;
  return (
    <nav aria-label={t('dashboard')} className="-mx-4 overflow-x-auto px-4">
      <ul className="flex gap-1 border-b">
        {TABS.map(([key, suffix]) => {
          const href = `${base}${suffix}`;
          const current = pathname === href;
          return (
            <li key={key}>
              <Link
                href={href as Route}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'inline-block whitespace-nowrap border-b-2 px-3 py-2 text-sm',
                  current
                    ? 'border-brand font-semibold text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t(key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

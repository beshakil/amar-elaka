'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import { buildBreadcrumbs } from '@/lib/nav/breadcrumbs';

export function Breadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations('breadcrumb');
  const crumbs = buildBreadcrumbs(pathname);

  return (
    <nav aria-label={t('label')}>
      <ol className="flex items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => (
          <li key={crumb.href} className="flex items-center gap-1">
            {index > 0 ? (
              <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
            ) : null}
            {crumb.isCurrent ? (
              <span aria-current="page">{t.has(crumb.key) ? t(crumb.key) : crumb.key}</span>
            ) : (
              // Built by concatenating segments of the current pathname, so it
              // is by construction a route this app serves.
              <Link
                href={crumb.href as Route}
                className="text-muted-foreground hover:text-foreground"
              >
                {t.has(crumb.key) ? t(crumb.key) : crumb.key}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

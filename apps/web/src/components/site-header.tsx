import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { MapPin } from 'lucide-react';
import { SearchBox } from '@/components/search/search-box';
import { LogoutButton } from '@/components/logout-button';
import { ThemeToggle } from '@/components/theme-toggle';
import { readSession } from '@/lib/auth/session';
import type { TenantConfig } from '@/lib/api/schemas';
import { storageUrl } from '@/lib/env';
import type { ThemePreference } from '@/lib/theme';

const NAV = [
  { href: '/', key: 'home' },
  { href: '/map', key: 'map' },
  { href: '/info', key: 'info' },
] as const;

export async function SiteHeader({
  tenant,
  theme,
}: {
  tenant: TenantConfig | null;
  theme: ThemePreference;
}) {
  const t = await getTranslations('site');
  const tNav = await getTranslations('nav');
  const tArea = await getTranslations('areaSwitcher');
  const logoKey = tenant?.branding.logoStorageKey;
  // Whether a session cookie exists (the pages behind it check it properly).
  const signedIn = tenant !== null && (await readSession()) !== null;

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold">
          {logoKey ? (
            // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
            <img src={storageUrl(logoKey)} alt="" className="size-8 rounded-md object-cover" />
          ) : null}
          আমার এলাকা
        </Link>

        {tenant ? (
          <Link
            href="/areas"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm hover:bg-muted"
            aria-label={tArea('change')}
          >
            <MapPin className="size-4 text-muted-foreground" aria-hidden />
            {tenant.nameBn}
          </Link>
        ) : null}

        <Suspense fallback={<div className="order-last min-w-0 flex-1 sm:order-none" />}>
          <SearchBox
            // The seeded search_suggest_min_chars when no tenant (or an older API) says.
            minChars={tenant?.search?.suggestMinChars ?? 2}
            labels={{
              placeholder: t('searchPlaceholder'),
              submit: t('searchSubmit'),
              categories: t('suggestCategories'),
              queries: t('suggestQueries'),
              listings: t('suggestListings'),
              announce: t.raw('suggestCount') as string,
            }}
          />
        </Suspense>

        <nav className="flex items-center gap-1 text-sm">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="rounded-md px-2 py-1 hover:bg-muted">
              {tNav(item.key)}
            </Link>
          ))}
          {tenant && (
            <>
              <Link
                href="/post/new"
                className="rounded-md bg-brand px-2 py-1 text-brand-foreground hover:opacity-90"
              >
                {tNav('post')}
              </Link>
              {signedIn ? (
                <>
                  <a href="/me/posts" className="rounded-md px-2 py-1 hover:bg-muted">
                    {tNav('myPosts')}
                  </a>
                  <LogoutButton label={tNav('logout')} />
                </>
              ) : (
                <a href="/login" className="rounded-md px-2 py-1 hover:bg-muted">
                  {tNav('login')}
                </a>
              )}
            </>
          )}
        </nav>

        <ThemeToggle current={theme} />
      </div>
    </header>
  );
}

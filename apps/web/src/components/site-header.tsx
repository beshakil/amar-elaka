import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { MapPin, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ThemeToggle } from '@/components/theme-toggle';
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

        <form
          action="/"
          className="order-last flex min-w-0 flex-1 items-center gap-2 sm:order-none"
        >
          <div className="relative w-full">
            <Search
              className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              name="q"
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
            />
          </div>
        </form>

        <nav className="flex items-center gap-1 text-sm">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="rounded-md px-2 py-1 hover:bg-muted">
              {tNav(item.key)}
            </Link>
          ))}
        </nav>

        <ThemeToggle current={theme} />
      </div>
    </header>
  );
}

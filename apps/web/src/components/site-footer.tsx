import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { TenantConfig } from '@/lib/api/schemas';

export async function SiteFooter({ tenant }: { tenant: TenantConfig | null }) {
  const t = await getTranslations('footer');
  const year = new Date().getFullYear();

  return (
    <footer className="mt-12 border-t border-border bg-card">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-sm text-muted-foreground">
        <p>
          © {year} {tenant?.nameBn ?? 'আমার এলাকা'} — {t('rights')}
        </p>
        <nav className="flex gap-4">
          <Link href="/info" className="hover:text-foreground">
            {t('about')}
          </Link>
          <Link href="/info" className="hover:text-foreground">
            {t('terms')}
          </Link>
          <Link href="/info" className="hover:text-foreground">
            {t('privacy')}
          </Link>
        </nav>
      </div>
    </footer>
  );
}

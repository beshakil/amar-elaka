'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { setThemePreference } from '@/app/actions/theme';
import { Breadcrumbs } from '@/components/shell/breadcrumbs';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ThemePreference } from '@/lib/ui-preferences';

const THEMES: { value: ThemePreference; icon: typeof Sun }[] = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
];

export function Topbar({
  displayName,
  roleLabel,
  tenantName,
  theme,
}: {
  displayName: string;
  roleLabel: string;
  tenantName: string;
  theme: ThemePreference;
}) {
  const t = useTranslations('shell');
  const tTheme = useTranslations('theme');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function chooseTheme(preference: ThemePreference) {
    startTransition(async () => {
      await setThemePreference(preference);
      router.refresh();
    });
  }

  function logout() {
    startTransition(async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.replace('/login');
      router.refresh();
    });
  }

  return (
    <header className="flex h-14 items-center gap-4 border-b border-border bg-card px-4">
      <Breadcrumbs />

      <div className="ms-auto flex items-center gap-2">
        <span className="hidden text-sm text-muted-foreground sm:inline">{tenantName}</span>

        <div
          role="group"
          aria-label={tTheme('label')}
          className="inline-flex rounded-md border border-border p-0.5"
        >
          {THEMES.map(({ value, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => chooseTheme(value)}
              disabled={isPending}
              aria-pressed={theme === value}
              title={tTheme(value)}
              className={
                theme === value
                  ? 'inline-flex size-7 items-center justify-center rounded-sm bg-muted'
                  : 'inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted'
              }
            >
              <Icon className="size-4" aria-hidden />
              <span className="sr-only">{tTheme(value)}</span>
            </button>
          ))}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {displayName}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{roleLabel}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={logout}>
              <LogOut className="size-4" aria-hidden />
              {t('logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

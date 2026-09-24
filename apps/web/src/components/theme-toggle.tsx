'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Monitor, Moon, Sun } from 'lucide-react';
import { setThemePreference } from '@/app/actions/theme';
import type { ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';

const OPTIONS: {
  value: ThemePreference;
  icon: typeof Sun;
  labelKey: 'light' | 'dark' | 'system';
}[] = [
  { value: 'light', icon: Sun, labelKey: 'light' },
  { value: 'dark', icon: Moon, labelKey: 'dark' },
  { value: 'system', icon: Monitor, labelKey: 'system' },
];

/**
 * Writes the preference to a cookie and refreshes, so the next render's
 * `<html data-theme>` comes from the server — the same path a first visit
 * takes, which is why there is no flash on either.
 */
export function ThemeToggle({ current }: { current: ThemePreference }) {
  const t = useTranslations('theme');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function select(preference: ThemePreference) {
    startTransition(async () => {
      await setThemePreference(preference);
      router.refresh();
    });
  }

  return (
    <div
      role="group"
      aria-label={t('label')}
      className="inline-flex rounded-md border border-border p-0.5"
    >
      {OPTIONS.map(({ value, icon: Icon, labelKey }) => (
        <button
          key={value}
          type="button"
          onClick={() => select(value)}
          disabled={isPending}
          aria-pressed={current === value}
          title={t(labelKey)}
          className={cn(
            'inline-flex size-8 items-center justify-center rounded-sm transition-colors',
            current === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted',
          )}
        >
          <Icon className="size-4" aria-hidden />
          <span className="sr-only">{t(labelKey)}</span>
        </button>
      ))}
    </div>
  );
}

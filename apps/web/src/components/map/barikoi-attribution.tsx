'use client';

import { useTranslations } from 'next-intl';

/**
 * Credit shown wherever a Barikoi search or address result is displayed
 * (ADR 043). PLACEHOLDER WORDING (messages `map.barikoiAttribution`): to be
 * confirmed against Barikoi's terms before launch. Shown only for results
 * whose `source` is the provider, never for our own area data.
 */
export function BarikoiAttribution() {
  const t = useTranslations('map');
  return (
    <p className="text-xs text-muted-foreground" data-testid="barikoi-attribution">
      {t('barikoiAttribution')}
    </p>
  );
}

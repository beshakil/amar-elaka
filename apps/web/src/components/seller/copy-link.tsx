'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/** The catalog link, selectable, with a copy button that says when it worked. */
export function CopyLink({ url }: { url: string }) {
  const t = useTranslations('seller.catalog');
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        readOnly
        value={url}
        aria-label={t('link')}
        onFocus={(event) => event.target.select()}
        className="h-10 min-w-0 flex-1 rounded-md border bg-muted px-3 text-sm"
      />
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          void navigator.clipboard.writeText(url).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? t('copied') : t('copy')}
      </Button>
    </div>
  );
}

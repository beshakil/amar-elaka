'use client';

import { Bookmark, BookmarkCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

type Outcome = 'saved' | 'already' | 'failed' | null;

/**
 * "সেভ করুন" on a listing page (ADR 037). The page is cached for everyone,
 * so it can't know whether this visitor saved the post: a tap asks this
 * site's /api/posts/<id>/save and says what happened. Without a session it
 * goes to login and back.
 */
export function SaveButton({ postId, loginPath }: { postId: string; loginPath: string }) {
  const t = useTranslations('listing.save');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function save() {
    setBusy(true);
    try {
      const response = await fetch(`/api/posts/${postId}/save`, { method: 'POST' });
      if (response.status === 401) {
        window.location.assign(loginPath);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { created?: boolean };
      setOutcome(response.ok ? (body.created === false ? 'already' : 'saved') : 'failed');
    } catch {
      setOutcome('failed');
    } finally {
      setBusy(false);
    }
  }

  const done = outcome === 'saved' || outcome === 'already';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        onClick={() => void save()}
        disabled={busy || done}
        data-testid="listing-save"
      >
        {done ? (
          <BookmarkCheck className="size-4" aria-hidden />
        ) : (
          <Bookmark className="size-4" aria-hidden />
        )}
        {done ? t('saved') : t('save')}
      </Button>
      <span role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {outcome === 'saved' && t('savedNote')}
        {outcome === 'already' && t('already')}
        {outcome === 'failed' && t('failed')}
      </span>
    </div>
  );
}

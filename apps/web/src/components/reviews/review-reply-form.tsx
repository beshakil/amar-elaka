'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { respondToReview } from '@/lib/reviews/actions';

/** The store's reply to one review (the seller panel): one, editable. */
export function ReviewReplyForm({
  storeId,
  reviewId,
  current,
}: {
  storeId: string;
  reviewId: string;
  current: string | null;
}) {
  const t = useTranslations('reviews');
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid={`review-reply-open-${reviewId}`}
        >
          {current ? t('editReply') : t('reply')}
        </Button>
        {status && (
          <span role="status" className="text-xs text-muted-foreground">
            {status}
          </span>
        )}
      </div>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void respondToReview(storeId, reviewId, text).then((result) => {
          setBusy(false);
          setStatus(result.ok ? t('replySaved') : t('replyFailed'));
          if (result.ok) setOpen(false);
        });
      }}
    >
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('replyHint')}
        aria-label={t('replyHint')}
        className="min-h-20 w-full rounded-md border border-border bg-background p-2 text-sm"
        data-testid={`review-reply-input-${reviewId}`}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !text.trim()}>
          {t('replySend')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

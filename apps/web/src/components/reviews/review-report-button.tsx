'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Flag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { reportReview } from '@/lib/reviews/actions';

const REASONS = ['fake_review', 'harassment', 'spam', 'other'] as const;

/** "রিপোর্ট করুন" on a review: a reason and a few words; signed-out visitors go to login. */
export function ReviewReportButton({
  storeId,
  reviewId,
  loginPath,
}: {
  storeId: string;
  reviewId: string;
  loginPath: string;
}) {
  const t = useTranslations('reviews');
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function send(form: HTMLFormElement) {
    const data = new FormData(form);
    const details = data.get('details');
    const result = await reportReview(storeId, reviewId, {
      reasonCode: data.get('reasonCode'),
      details: typeof details === 'string' && details.trim() ? details.trim() : null,
    });
    dialog.current?.close();
    if (!result.ok && result.code === 'UNAUTHENTICATED') {
      window.location.assign(loginPath);
      return;
    }
    setStatus(result.ok ? t('reportSent') : t('reportFailed'));
  }

  return (
    <>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
        onClick={() => dialog.current?.showModal()}
        data-testid={`review-report-${reviewId}`}
      >
        <Flag className="size-3.5" aria-hidden />
        {t('report')}
      </button>
      {status && (
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
      )}
      <dialog
        ref={dialog}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-4 text-foreground backdrop:bg-black/40"
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send(event.currentTarget);
          }}
        >
          <h2 className="font-semibold">{t('reportTitle')}</h2>
          {REASONS.map((reason, i) => (
            <label key={reason} className="flex items-center gap-2 text-sm">
              <input type="radio" name="reasonCode" value={reason} defaultChecked={i === 0} />
              {t(`reportReasons.${reason}`)}
            </label>
          ))}
          <textarea
            name="details"
            placeholder={t('reportDetailsHint')}
            className="w-full rounded-md border border-border bg-background p-2 text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => dialog.current?.close()}>
              {t('cancel')}
            </Button>
            <Button type="submit">{t('reportSend')}</Button>
          </div>
        </form>
      </dialog>
    </>
  );
}

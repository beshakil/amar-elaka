import type { Route } from 'next';
import Link from 'next/link';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ReviewItem, ReviewSummary } from '@/components/reviews/review-display';
import { ReviewReplyForm } from '@/components/reviews/review-reply-form';
import { ReviewReportButton } from '@/components/reviews/review-report-button';
import { requireViewer } from '@/lib/auth/viewer';
import { pickMessages } from '@/lib/i18n-messages';
import { reviewLabels } from '@/lib/reviews/labels';
import { sellerReviews } from '@/lib/reviews/load';

/**
 * The store's reviews in the seller panel (ADR 061): the summary and the
 * tier, every review — reply to each (one reply, editable), report the
 * ones that look wrong. Never delete: nobody can, a moderator decides.
 */
export default async function SellerReviewsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const [{ storeId }, query, viewer] = await Promise.all([params, searchParams, requireViewer()]);
  const before = z.string().uuid().safeParse(query.before);
  const [page, labels, messages, t] = await Promise.all([
    sellerReviews(viewer, storeId, before.success ? before.data : undefined),
    reviewLabels(),
    getMessages(),
    getTranslations('reviews'),
  ]);
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">{t('sellerTitle')}</h2>
      <ReviewSummary summary={page.summary} labels={labels} />
      <p className="text-sm text-muted-foreground">{t('ownerCannotDelete')}</p>
      <NextIntlClientProvider messages={pickMessages(messages, ['reviews'])}>
        {page.items.length === 0 ? (
          <p className="text-muted-foreground">{t('none')}</p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border bg-card px-4">
            {page.items.map((review) => (
              <div key={review.id} className="space-y-2 pb-3">
                <ReviewItem
                  review={review}
                  labels={labels}
                  actions={
                    <ReviewReportButton storeId={storeId} reviewId={review.id} loginPath="/login" />
                  }
                />
                <ReviewReplyForm
                  storeId={storeId}
                  reviewId={review.id}
                  current={review.response?.text ?? null}
                />
              </div>
            ))}
          </div>
        )}
      </NextIntlClientProvider>
      {page.nextBefore && (
        <Link
          href={`/seller/${storeId}/reviews?before=${page.nextBefore}` as Route}
          className="block text-center text-sm text-brand hover:underline"
        >
          {t('more')}
        </Link>
      )}
    </div>
  );
}

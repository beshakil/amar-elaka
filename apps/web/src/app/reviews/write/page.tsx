import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { reviewDate } from '@/components/reviews/review-display';
import { ReviewForm } from '@/components/reviews/review-form';
import { safeNext } from '@/lib/auth/session';
import { requireViewer } from '@/lib/auth/viewer';
import { pickMessages } from '@/lib/i18n-messages';
import { reviewEligibility } from '@/lib/reviews/load';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * /reviews/write?store=<id>&back=<path> (ADR 061): write, or edit, the
 * viewer's review of a store — or why not yet (no contact, too soon, too
 * late). Sign-in first (middleware). Reached from the store page and from a
 * "how was it?" notification.
 */
export default async function WriteReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; back?: string }>;
}) {
  const query = await searchParams;
  const store = z.string().uuid().safeParse(query.store);
  if (!store.success) notFound();
  const viewer = await requireViewer();
  const [eligibility, messages, t] = await Promise.all([
    reviewEligibility(viewer, store.data),
    getMessages(),
    getTranslations('reviews'),
  ]);
  const back = safeNext(query.back, '/');
  const mine = eligibility.myReview;
  const editable =
    mine !== null &&
    new Date(mine.editableUntil) > new Date() &&
    !['hidden', 'removed'].includes(mine.status);
  const blocked =
    eligibility.status === 'eligible' || (eligibility.status === 'already_reviewed' && editable)
      ? null
      : eligibility.status === 'already_reviewed'
        ? t('blocked.edit_over')
        : eligibility.status === 'too_soon' && eligibility.eligibleAt
          ? t('blocked.too_soon', { date: reviewDate(eligibility.eligibleAt) })
          : eligibility.status === 'signed_out'
            ? t('blocked.no_contact')
            : t(`blocked.${eligibility.status === 'too_soon' ? 'no_contact' : eligibility.status}`);

  return (
    <section className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">{mine ? t('edit') : t('write')}</h1>
      {mine?.status === 'pending' && (
        <p className="text-sm text-muted-foreground">{t('pendingNote')}</p>
      )}
      {blocked ? (
        <p className="rounded-lg border border-border p-4" data-testid="review-blocked">
          {blocked}
        </p>
      ) : (
        <NextIntlClientProvider messages={pickMessages(messages, ['reviews'])}>
          <ReviewForm storeId={store.data} backTo={back} mine={editable ? mine : null} />
        </NextIntlClientProvider>
      )}
      {mine && editable && (
        <p className="text-xs text-muted-foreground">
          {t('editableUntil', { date: reviewDate(mine.editableUntil) })}
        </p>
      )}
      <Link href={back as Route} className="text-sm text-brand hover:underline">
        {t('backToStore')}
      </Link>
    </section>
  );
}

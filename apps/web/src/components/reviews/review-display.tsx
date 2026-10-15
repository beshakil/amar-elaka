import { Award, BadgeCheck, Sparkles, Star, StarHalf, ThumbsUp, ShieldCheck } from 'lucide-react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import type { ReviewPage, SellerTier, StoreReview } from '@/lib/api/schemas';
import { cn } from '@/lib/utils';

/**
 * Reviews on the web (ADR 061), server-rendered: the stars, the seller tier
 * as a word (never the score), the summary, one review. Texts come in as
 * props (the caller's translations), so these render anywhere.
 */

const dateFormat = new Intl.DateTimeFormat('bn-BD', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Dhaka',
});
export const reviewDate = (iso: string) => dateFormat.format(new Date(iso));

export function Stars({
  rating,
  label,
  size = 'size-4',
}: {
  rating: number;
  label: string;
  size?: string;
}) {
  return (
    <span
      className="inline-flex items-center text-amber-600 dark:text-amber-400"
      role="img"
      aria-label={label}
    >
      {[1, 2, 3, 4, 5].map((n) =>
        rating >= n ? (
          <Star key={n} className={cn(size, 'fill-current')} aria-hidden />
        ) : rating >= n - 0.5 ? (
          <StarHalf key={n} className={cn(size, 'fill-current')} aria-hidden />
        ) : (
          <Star key={n} className={size} aria-hidden />
        ),
      )}
    </span>
  );
}

const TIER_ICON = { top: Award, trusted: BadgeCheck, good: ThumbsUp, new: Sparkles } as const;

export function TierBadge({
  tier,
  label,
  explain,
}: {
  tier: SellerTier;
  label: string;
  explain: string;
}) {
  if (tier === 'none') return null;
  const Icon = TIER_ICON[tier];
  return (
    <span
      title={explain}
      data-testid={`seller-tier-${tier}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
        tier === 'top'
          ? 'border-amber-600 text-amber-700 dark:text-amber-400'
          : tier === 'new'
            ? 'border-border text-muted-foreground'
            : 'border-brand text-brand',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

export interface ReviewLabels {
  count: (n: string) => string;
  stars: (n: string) => string;
  formerMember: string;
  member: string;
  verifiedContact: string;
  storeReply: string;
  edited: string;
  tier: (tier: Exclude<SellerTier, 'none'>) => string;
  tierExplain: string;
}

export function ReviewSummary({
  summary,
  labels,
}: {
  summary: ReviewPage['summary'];
  labels: ReviewLabels;
}) {
  const n = (v: number) => localizeDigits(String(v), 'bn');
  return (
    <div className="flex flex-wrap items-start gap-6" data-testid="review-summary">
      <div className="text-center">
        <div className="text-4xl font-semibold">
          {summary.average === null ? '–' : localizeDigits(summary.average.toFixed(1), 'bn')}
        </div>
        <Stars rating={summary.average ?? 0} label={labels.stars(n(summary.average ?? 0))} />
        <div className="text-xs text-muted-foreground">{labels.count(n(summary.count))}</div>
      </div>
      <div className="min-w-48 flex-1 space-y-1">
        {([5, 4, 3, 2, 1] as const).map((star) => {
          const value = summary.histogram[String(star) as '1'];
          return (
            <div key={star} className="flex items-center gap-2 text-xs">
              <span className="w-3">{n(star)}</span>
              <span className="h-1.5 flex-1 rounded-full bg-muted">
                <span
                  className="block h-1.5 rounded-full bg-brand"
                  style={{ width: summary.count === 0 ? 0 : `${(value / summary.count) * 100}%` }}
                />
              </span>
            </div>
          );
        })}
        {summary.tier !== 'none' && (
          <div className="pt-1">
            <TierBadge
              tier={summary.tier}
              label={labels.tier(summary.tier)}
              explain={labels.tierExplain}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function ReviewItem({
  review,
  labels,
  actions,
}: {
  review: StoreReview;
  labels: ReviewLabels;
  actions?: React.ReactNode;
}) {
  const name = review.authorRemoved ? labels.formerMember : (review.authorName ?? labels.member);
  return (
    <article className="space-y-1 py-3" data-testid={`review-${review.id}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium">{name}</h3>
        {actions}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <Stars
          rating={review.rating}
          label={labels.stars(localizeDigits(String(review.rating), 'bn'))}
        />
        <span>
          {reviewDate(review.createdAt)}
          {review.editedAt && ` · ${labels.edited}`}
        </span>
        <span className="inline-flex items-center gap-1">
          <ShieldCheck className="size-3.5 text-brand" aria-hidden />
          {labels.verifiedContact}
        </span>
      </div>
      {review.text && <p className="whitespace-pre-line break-words">{review.text}</p>}
      {review.photos.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {review.photos.map((p) =>
            p.thumbUrl ? (
              <a
                key={p.id}
                href={p.fullUrl ?? p.thumbUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time */}
                <img src={p.thumbUrl} alt="" className="size-20 rounded-md object-cover" />
              </a>
            ) : null,
          )}
        </div>
      )}
      {review.response && (
        <div
          className="mt-2 rounded-md bg-muted p-3 text-sm"
          data-testid={`review-reply-${review.id}`}
        >
          <div className="text-xs font-medium text-muted-foreground">{labels.storeReply}</div>
          <p className="whitespace-pre-line">{review.response.text}</p>
        </div>
      )}
    </article>
  );
}

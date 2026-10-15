import { getTranslations } from 'next-intl/server';
import type { ReviewLabels } from '@/components/reviews/review-display';

/** The review display's texts, from the `reviews` messages (server components). */
export async function reviewLabels(): Promise<ReviewLabels> {
  const t = await getTranslations('reviews');
  return {
    count: (count) => t('count', { count }),
    stars: (count) => t('stars', { count }),
    formerMember: t('formerMember'),
    member: t('member'),
    verifiedContact: t('verifiedContact'),
    storeReply: t('storeReply'),
    edited: t('edited'),
    tier: (tier) => t(`tiers.${tier}`),
    tierExplain: t('tierExplain'),
  };
}

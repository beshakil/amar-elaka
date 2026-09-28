import { formatMoney } from '@amar-elaka/dynamic-form';
import type { PostCard, SearchHit } from '../api/schemas';
import { listingPath } from '../seo/slug';

/** The price words a listing uses, from the `listing` messages. */
export interface PriceWords {
  free: string;
  priceOnRequest: string;
  negotiable: string;
  perMonth: string;
}

/** "৳ ৬৫,০০০", "৳ ৮,০০০/মাস", "ফ্রি", or "দাম জানতে যোগাযোগ করুন". */
export function priceLabel(
  price: string | null,
  priceType: string | null,
  words: PriceWords,
): string {
  if (priceType === 'free') return words.free;
  if (price === null) return words.priceOnRequest;
  const amount = `৳ ${formatMoney(price, 'bn')}`;
  if (priceType === 'per_month') return `${amount}${words.perMonth}`;
  return amount;
}

/** The amount alone, for "{price} টাকা" in a title: "৬৫,০০০". */
export function priceDigits(price: string): string {
  return formatMoney(price, 'bn');
}

/** What a listing card shows, from a search hit or a feed-style post card. */
export interface ListingCardData {
  id: string;
  href: string;
  title: string;
  price: string;
  imageUrl: string | null;
  meta: string | null;
  badges: string[];
  sold?: boolean;
}

export function cardFromHit(hit: SearchHit, words: PriceWords): ListingCardData {
  const title = hit.name.bn ?? hit.name.en ?? '';
  return {
    id: hit.id,
    href: listingPath(hit.id, title),
    title,
    price: priceLabel(hit.price, null, words),
    imageUrl: hit.cover?.thumbUrl ?? null,
    meta: [hit.area?.bn, hit.category?.name.bn].filter(Boolean).join(' · ') || null,
    badges: hit.isBoosted ? ['boosted'] : [],
  };
}

export function cardFromPost(card: PostCard, words: PriceWords): ListingCardData {
  return {
    id: card.id,
    href: listingPath(card.id, card.title),
    title: card.title,
    price: priceLabel(card.price, card.badges.includes('free') ? 'free' : null, words),
    imageUrl: card.cover?.url ?? null,
    meta: card.area?.bn ?? null,
    badges: card.badges.filter((b) => b !== 'free'),
  };
}

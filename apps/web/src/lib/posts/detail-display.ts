import { formatMoney, localizeDigits, parseMoneyInput } from '@amar-elaka/dynamic-form';
import type { PostDetail } from '../api/schemas';
import { text } from '../text';

type DetailField = PostDetail['fields'][number];

/**
 * A detail field as a reader sees it, from what the API already resolved
 * against the post's own schema version: option labels, Bengali digits,
 * grouped money. Null when there's nothing to show.
 */
export function detailFieldValue(
  field: DetailField,
  yesNo: { yes: string; no: string },
): string | null {
  const { value } = field;
  if (value === undefined || value === null || value === '') return null;
  switch (field.type) {
    case 'select':
    case 'multiselect': {
      const labels = (field.optionLabels ?? []).map((option) => option.bn ?? option.en ?? '');
      return labels.filter((label) => label !== '').join(', ') || null;
    }
    case 'bool':
      return value === true ? yesNo.yes : yesNo.no;
    case 'money':
      return `৳ ${formatMoney(parseMoneyInput(text(value)) ?? text(value), 'bn')}`;
    case 'phone':
      return localizeDigits(text(value).replace(/^\+88/, ''), 'bn');
    default:
      return localizeDigits(text(value), 'bn');
  }
}

/** The headline price: "৳ ১২,৫০০", with the price type's word where it has one. */
export function priceLine(
  post: Pick<PostDetail, 'price' | 'priceType'>,
  words: { free: string; onRequest: string; negotiable: string; perMonth: string },
): string {
  if (post.priceType === 'free') return words.free;
  if (post.price === null) return words.onRequest;
  const amount = `৳ ${formatMoney(post.price, 'bn')}`;
  if (post.priceType === 'negotiable') return `${amount} (${words.negotiable})`;
  if (post.priceType === 'per_month') return `${amount}${words.perMonth}`;
  return amount;
}

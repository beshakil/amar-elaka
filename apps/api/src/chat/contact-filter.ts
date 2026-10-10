import { containsPhoneNumber, countLinks } from '../moderation/prefilter';

/**
 * The chat's contact check (ADR 058). It uses the post pre-filter's own
 * matchers (moderation/prefilter.ts): one phone-number rule and one link
 * rule for the whole platform (month-2-gaps §8.2), so Bengali digits
 * (০১৭…) and digits split by spaces or dashes are caught here exactly as
 * in a post.
 *
 *   within the window  (fewer than `firstMessages` messages so far):
 *                      a number or link is held back — `blocked`
 *   after the window   it goes through, `flagged` for moderation
 *   firstMessages = 0  the tenant turned the check off: never held back,
 *                      still flagged
 */
export type ContactCheck =
  | { outcome: 'clean' }
  | { outcome: 'flagged' }
  | { outcome: 'blocked'; found: 'phone' | 'link'; remaining: number };

export function checkContactInfo(
  text: string,
  messagesSoFar: number,
  firstMessages: number,
): ContactCheck {
  const found = containsPhoneNumber(text) ? 'phone' : countLinks(text) > 0 ? 'link' : null;
  if (found === null) return { outcome: 'clean' };
  if (messagesSoFar < firstMessages) {
    return { outcome: 'blocked', found, remaining: firstMessages - messagesSoFar };
  }
  return { outcome: 'flagged' };
}

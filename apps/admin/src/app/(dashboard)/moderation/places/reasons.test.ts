import { describe, expect, it } from 'vitest';
import messages from '../../../../messages/bn.json';
import { TAKEDOWN_REASONS } from '../reasons';
import {
  CLAIM_REJECT_REASONS,
  isPlaceTab,
  PLACE_REPORT_REASONS,
  PLACE_TABS,
  REPORT_DECISIONS,
  SUGGESTION_REJECT_REASONS,
} from './reasons';

const places = messages.moderation.places as unknown as Record<string, Record<string, string>>;
const takedown = messages.moderation.takedown as Record<string, string>;

/** The label the Places tab shows for a reason code (takedown codes share the posts' labels). */
const label = (code: string) =>
  (TAKEDOWN_REASONS as readonly string[]).includes(code) ? takedown[code] : places.reason![code];

describe('the Places tab', () => {
  it('reads its sub-tab from the query, defaulting to nothing unknown', () => {
    expect(isPlaceTab('reports')).toBe(true);
    expect(isPlaceTab('posts')).toBe(false);
    expect(isPlaceTab(undefined)).toBe(false);
  });

  it('has a Bengali label for every tab, reason and decision it can show', () => {
    for (const tab of PLACE_TABS) expect(places.tab![tab]).toBeTruthy();
    for (const code of [...CLAIM_REJECT_REASONS, ...SUGGESTION_REJECT_REASONS]) {
      expect(label(code)).toBeTruthy();
    }
    for (const code of PLACE_REPORT_REASONS) expect(places.reportReason![code]).toBeTruthy();
    for (const decision of REPORT_DECISIONS) {
      expect(places.decision![decision]).toBeTruthy();
      expect(places.decided![decision]).toBeTruthy();
    }
  });
});

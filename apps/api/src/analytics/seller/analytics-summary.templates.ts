import { bengaliNumber } from '../../common/text/bengali-numerals';

/**
 * rule 6: the one place the analytics screen's headline is worded — "people
 * found you, and this many contacted you", in Bengali (the platform default)
 * and English. People, not views: distinct viewers and distinct contacters.
 */
export interface SummaryFacts {
  days: number;
  viewers: number;
  contacters: number;
  /** Whose numbers: a store's (its page and posts) or the seller's own posts. */
  subject: 'store' | 'posts';
}

const BN_SUBJECT = { store: 'আপনার দোকান', posts: 'আপনার পোস্ট' } as const;
const EN_SUBJECT = { store: 'your store', posts: 'your posts' } as const;

function bn(f: SummaryFacts): string {
  const since = `গত ${bengaliNumber(f.days)} দিনে`;
  if (f.viewers === 0) return `${since} এখনও কেউ ${BN_SUBJECT[f.subject]} দেখেননি।`;
  const seen = `${since} ${bengaliNumber(f.viewers)} জন ${BN_SUBJECT[f.subject]} দেখেছেন`;
  return f.contacters === 0
    ? `${seen}, এখনও কেউ যোগাযোগ করেননি।`
    : `${seen}, ${bengaliNumber(f.contacters)} জন যোগাযোগ করেছেন।`;
}

const people = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`;

function en(f: SummaryFacts): string {
  const since = `In the last ${f.days} days`;
  if (f.viewers === 0) return `${since}, nobody has seen ${EN_SUBJECT[f.subject]} yet.`;
  const seen = `${since}, ${people(f.viewers)} saw ${EN_SUBJECT[f.subject]}`;
  return f.contacters === 0
    ? `${seen}; nobody has contacted you yet.`
    : `${seen} and ${people(f.contacters)} contacted you.`;
}

export function analyticsSummary(facts: SummaryFacts): { bn: string; en: string } {
  return { bn: bn(facts), en: en(facts) };
}

// settings-exempt: rounding to numeric(4,3), the column's own precision.
const SCORE_SCALE = 1000;

/** The raw signals the database measures for one nearby place or store (0043). */
export interface DuplicateSignals {
  /** Best pg_trgm similarity of the name keys (Bengali, transliterated, English), 0–1. */
  nameSimilarity: number;
  /** They share a phone number. */
  phoneMatch: boolean;
  /** Same category (places); null when it doesn't apply (stores). */
  sameCategory: boolean | null;
  distanceM: number;
}

/** The scoring knobs, all settings (rule 9). */
export interface DuplicateWeights {
  likelyScore: number;
  possibleScore: number;
  phoneBonus: number;
  categoryMismatchFactor: number;
}

export type DuplicateClass = 'likely' | 'possible';

/**
 * How alike two entities are, 0–1: the name similarity, plus a bonus for a
 * shared phone (the strongest single signal), scaled down when the categories
 * differ. Distance is the gate, not a weight: only things within
 * duplicate_radius_m are ever scored.
 */
export function duplicateScore(signals: DuplicateSignals, weights: DuplicateWeights): number {
  const raw = Math.min(1, signals.nameSimilarity + (signals.phoneMatch ? weights.phoneBonus : 0));
  const scaled = signals.sameCategory === false ? raw * weights.categoryMismatchFactor : raw;
  return Math.round(scaled * SCORE_SCALE) / SCORE_SCALE;
}

/** likely ≥ duplicate_likely_score, possible ≥ duplicate_possible_score, else not a duplicate. */
export function classifyDuplicate(score: number, weights: DuplicateWeights): DuplicateClass | null {
  if (score >= weights.likelyScore) return 'likely';
  if (score >= weights.possibleScore) return 'possible';
  return null;
}

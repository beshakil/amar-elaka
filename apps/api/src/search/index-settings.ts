import type { EngineIndexSettings } from './engine/search-engine.port';
import {
  FILTERABLE_ATTRIBUTES,
  RANKING_RULES,
  SEARCHABLE_ATTRIBUTES,
  SORTABLE_ATTRIBUTES,
  type SearchDocument,
} from './search.types';

export interface IndexTuning {
  /** search_typo_one_typo_min_chars / search_typo_two_typos_min_chars */
  oneTypoMinChars: number;
  twoTyposMinChars: number;
  /** search_facet_values_max */
  facetValuesMax: number;
  /** search_max_total_hits */
  maxTotalHits: number;
}

/** Searchable, never shown: variants are matching noise, not display text. */
const HIDDEN_ATTRIBUTES: ReadonlySet<keyof SearchDocument> = new Set(['name_variants']);

const DISPLAYED_ATTRIBUTES: (keyof SearchDocument)[] = (
  [
    'id',
    'tenant_id',
    'name_bn',
    'name_en',
    'name_translit',
    'description',
    'category_id',
    'category_slug',
    'category_name_bn',
    'category_name_en',
    'locality_id',
    'area_name_bn',
    'area_name_en',
    '_geo',
    'is_boosted',
    'published_at',
    'card_fields',
    'price_minor',
    'rating_avg',
    'slug',
    'cover_thumb_key',
    'cover_thumbhash',
    'is_verified',
    'is_landmark',
  ] satisfies (keyof SearchDocument)[]
).filter((a) => !HIDDEN_ATTRIBUTES.has(a));

/**
 * The same settings for all three indexes. Typo tolerance is tuned for
 * Bengali: its words are short in letters but long in code points (ডাক্তার
 * is 7: ড া ক ্ ত া র), and the common misspellings are one-sign slips
 * (ি/ী, ু/ূ, a missing hasanta), so one typo is allowed from 4 code points
 * and two from 8 by default, rather than Meilisearch's 5 and 9.
 */
export function buildIndexSettings(
  synonyms: Record<string, string[]>,
  tuning: IndexTuning,
): EngineIndexSettings {
  return {
    searchableAttributes: [...SEARCHABLE_ATTRIBUTES],
    filterableAttributes: [...FILTERABLE_ATTRIBUTES],
    sortableAttributes: [...SORTABLE_ATTRIBUTES],
    displayedAttributes: DISPLAYED_ATTRIBUTES,
    rankingRules: [...RANKING_RULES],
    synonyms,
    typoTolerance: {
      enabled: true,
      minWordSizeForTypos: {
        oneTypo: tuning.oneTypoMinChars,
        twoTypos: tuning.twoTyposMinChars,
      },
      disableOnAttributes: [],
    },
    // The danda (।, ॥) ends Bengali sentences.
    separatorTokens: ['।', '॥'],
    faceting: { maxValuesPerFacet: tuning.facetValuesMax },
    pagination: { maxTotalHits: tuning.maxTotalHits },
  };
}

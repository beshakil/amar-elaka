import { z } from 'zod';
import { toPoisha } from '../../categories/field-schema';
import { createZodDto } from '../../common/pipes/zod-dto';
import { postCardSchema } from '../../feed/dto/feed.dto';
import { fieldFiltersObject, moneyParam } from '../../search/dto/search.dto';

// settings-exempt: generic input-length caps; the business limit is saved_search_name_max_length
const NAME_MAX_CHARS = 200;
// settings-exempt: generic input-length cap, as GET /search's q
const QUERY_MAX_CHARS = 200;
// settings-exempt: latitude/longitude ranges, facts of the coordinate system
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: mirrors saved_searches_radius_km_ck (0009); the upper bound is search_max_radius_km
const MIN_RADIUS_KM = 0.5;

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const SAVED_SEARCH_FREQUENCIES = ['instant', 'daily', 'off'] as const;
export type SavedSearchFrequency = (typeof SAVED_SEARCH_FREQUENCIES)[number];

/**
 * What narrows a saved search: the same meaning as GET /search's
 * `category`, `filters` (here as an object, not a JSON string),
 * `price_min` and `price_max`.
 */
export const savedSearchFiltersSchema = z
  .object({
    category: slug.optional(),
    /** `{field: {op: value}}`, checked against the category's schema. Needs `category`. */
    fields: fieldFiltersObject.optional(),
    price_min: moneyParam.optional(),
    price_max: moneyParam.optional(),
  })
  .strict()
  .refine((f) => f.fields === undefined || f.category !== undefined, {
    message: 'fields need a category',
    path: ['fields'],
  })
  .refine(
    (f) =>
      f.price_min === undefined ||
      f.price_max === undefined ||
      toPoisha(f.price_min) < toPoisha(f.price_max),
    { message: 'price_min must be below price_max', path: ['price_min'] },
  );
export type SavedSearchFilters = z.infer<typeof savedSearchFiltersSchema>;

const centerSchema = z.object({
  lat: z.number().min(-MAX_LAT).max(MAX_LAT),
  lng: z.number().min(-MAX_LNG).max(MAX_LNG),
});

/** POST /saved-searches. The radius is capped at search_max_radius_km, like GET /search. */
export const createSavedSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_CHARS),
    q: z.string().trim().max(QUERY_MAX_CHARS).default(''),
    filters: savedSearchFiltersSchema.default({}),
    center: centerSchema,
    radius_km: z.number().min(MIN_RADIUS_KM),
    frequency: z.enum(SAVED_SEARCH_FREQUENCIES).default('daily'),
  })
  .strict();
export class CreateSavedSearchDto extends createZodDto(createSavedSearchSchema) {}
export type CreateSavedSearch = z.infer<typeof createSavedSearchSchema>;

/**
 * PATCH /saved-searches/:id. `active: true` resumes a paused or switched-off
 * search (it counts against saved_search_max_active again); `active: false`
 * switches it off without deleting it.
 */
export const updateSavedSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_CHARS).optional(),
    q: z.string().trim().max(QUERY_MAX_CHARS).optional(),
    filters: savedSearchFiltersSchema.optional(),
    center: centerSchema.optional(),
    radius_km: z.number().min(MIN_RADIUS_KM).optional(),
    frequency: z.enum(SAVED_SEARCH_FREQUENCIES).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });
export class UpdateSavedSearchDto extends createZodDto(updateSavedSearchSchema) {}
export type UpdateSavedSearch = z.infer<typeof updateSavedSearchSchema>;

export const savedSearchIdParamSchema = z.object({ id: z.string().uuid() });
export class SavedSearchIdParamDto extends createZodDto(savedSearchIdParamSchema) {}

// ---- responses ----------------------------------------------------------

export const savedSearchSchema = z.object({
  id: z.string(),
  name: z.string(),
  q: z.string(),
  filters: z.object({
    category: z.string().nullable(),
    fields: z.record(z.record(z.unknown())),
    priceMin: z.string().nullable(),
    priceMax: z.string().nullable(),
  }),
  center: z.object({ lat: z.number(), lng: z.number() }),
  radiusKm: z.number(),
  frequency: z.enum(SAVED_SEARCH_FREQUENCIES),
  /** Matching and notifying: switched on and not paused. */
  active: z.boolean(),
  /** Set when it was auto-paused for not being opened (saved_search_auto_pause_days). */
  pausedAt: z.string().nullable(),
  /** The badge: results not opened yet. */
  newResultCount: z.number().int(),
  lastAlertedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type SavedSearch = z.infer<typeof savedSearchSchema>;
export class SavedSearchDto extends createZodDto(savedSearchSchema) {}

export const savedSearchListSchema = z.object({
  items: z.array(savedSearchSchema),
  /** All new results across the list: the app's badge. */
  newResultCount: z.number().int(),
  /** saved_search_max_active, and how many are active now. */
  maxActive: z.number().int(),
  activeCount: z.number().int(),
});
export type SavedSearchList = z.infer<typeof savedSearchListSchema>;
export class SavedSearchListDto extends createZodDto(savedSearchListSchema) {}

export const newResultsSchema = z.object({
  search: savedSearchSchema,
  /** New matches still live, newest first; opening them marks them seen. */
  results: z.array(postCardSchema),
});
export type NewResults = z.infer<typeof newResultsSchema>;
export class NewResultsDto extends createZodDto(newResultsSchema) {}

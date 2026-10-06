import { parseVariants } from '../media/media.types';
import type { StorageService } from '../storage/storage.ports';
import type { PlaceView } from './dto/places.dto';
import type { HoursRow, PlaceMediaRow, PlaceRow } from './places.repository';

export const OPEN_STATES: readonly string[] = [
  'published',
  'temporarily_closed',
  'permanently_closed',
];

type Photo = PlaceView['photos'][number];

function photoOf(storage: StorageService, m: PlaceMediaRow): Photo {
  const variants =
    m.status_code === 'ready' && m.visibility_code === 'public'
      ? parseVariants(m.variants)
      : undefined;
  const url = (name: 'thumb' | 'card' | 'full') =>
    variants ? storage.getPublicUrl('media', variants[name].key) : null;
  return {
    id: m.media_asset_id,
    thumbhash: m.thumbhash,
    thumbUrl: url('thumb'),
    cardUrl: url('card'),
    fullUrl: url('full'),
  };
}

/** The API shape of a place; `viewer` says what the caller is to it. */
export function toPlaceView(
  storage: StorageService,
  row: PlaceRow,
  media: readonly PlaceMediaRow[],
  hours: readonly HoursRow[],
  viewer: { isMine: boolean; canEdit: boolean; redirectedFrom: string | null },
): PlaceView {
  const street = media.find((m) => m.media_asset_id === row.street_photo_media_id);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status_code,
    categoryId: row.category_id,
    slug: row.slug,
    nameBn: row.name_bn,
    nameEn: row.name_en,
    description: row.description,
    phones: row.phones,
    addressText: row.address_text,
    location: { lat: row.lat, lng: row.lng },
    geoAreaId: row.geo_area_id,
    outsideBoundary: row.outside_boundary,
    isLandmark: row.is_landmark,
    landmarkRadiusKm: row.landmark_radius_km === null ? null : Number(row.landmark_radius_km),
    source: row.source_code,
    fieldVerified: row.field_verified_at !== null,
    photos: media
      .filter((m) => m.media_asset_id !== row.street_photo_media_id)
      .map((m) => photoOf(storage, m)),
    streetPhoto: street ? photoOf(storage, street) : null,
    businessHours: hours.map((h) => ({
      day: h.day,
      opens: h.opens,
      closes: h.closes,
      closesNextDay: h.next_day,
    })),
    claim: { claimed: row.claimed_by_member_id !== null, storeId: row.claim_store_id },
    rating: {
      avg: row.rating_avg === null ? null : Number(row.rating_avg),
      count: row.rating_count,
    },
    isMine: viewer.isMine,
    canEdit: viewer.canEdit,
    redirectedFrom: viewer.redirectedFrom,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** "HH:MM" pairs → place_hours rows; closing at or before opening runs past midnight. */
export function toHoursEntries(
  hours: readonly { day: number; opens: string; closes: string }[],
): { day: number; opens: string; closes: string; nextDay: boolean }[] {
  return hours.map((h) => ({ ...h, nextDay: h.closes <= h.opens }));
}

/** A URL slug: the English name's ASCII words, or `place`, plus a short random suffix. */
export function placeSlug(nameEn: string | undefined, suffix: string): string {
  const base = (nameEn ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'place'}-${suffix}`;
}

// settings-exempt: how much of a phone number a masked display keeps (+8801 … last three).
const MASK_PREFIX = 5;
// settings-exempt: see above
const MASK_SUFFIX = 3;

/** +8801712345678 → +8801••••••678: enough for the owner to recognise, not to harvest. */
export function maskPhone(phone: string): string {
  const hidden = Math.max(phone.length - MASK_PREFIX - MASK_SUFFIX, 0);
  return `${phone.slice(0, MASK_PREFIX)}${'•'.repeat(hidden)}${phone.slice(-MASK_SUFFIX)}`;
}

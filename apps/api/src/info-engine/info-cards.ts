import type { InfoCard } from './dto/info-engine.dto';
import type {
  ClusterRow,
  DirectoryRow,
  GovRow,
  LostFoundRow,
  NoticeRow,
  OutageRow,
  RouteRow,
} from './info-engine.repository';
import { isStale, latest, outagePhase } from './info-engine.rules';

/**
 * Every type's row as THE card (ADR 065) — pure, so the list endpoints, the
 * detail headers and the feed all show one shape. Badges are codes.
 */

// settings-exempt: a summary's length on a card (presentation, not a rule)
const SUMMARY_CHARS = 160;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const meters = (m: number | null): number | null => (m === null ? null : Math.round(m));
const snippet = (text: string | null): string | null =>
  text === null
    ? null
    : text.length > SUMMARY_CHARS
      ? `${text.slice(0, SUMMARY_CHARS - 1)}…`
      : text;

const base = {
  summary: null,
  startsAt: null,
  endsAt: null,
  isStale: false,
  distanceMeters: null,
  location: null,
  image: null,
} as const;

export function outageCard(row: OutageRow, now: Date): InfoCard {
  return {
    ...base,
    type: 'outage',
    id: row.id,
    tenantId: row.tenant_id,
    title: { bn: row.area_text ?? row.area_bn, en: row.area_text ?? row.area_en },
    summary: row.reason_text,
    badges: [row.utility_code, outagePhase(row.starts_at, row.ends_at, now), 'scheduled'],
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    updatedAt: iso(row.updated_at),
    distanceMeters: meters(row.distance_m),
  };
}

/** A reported (not scheduled) outage: its id is the area and utility, not a row. */
export function clusterCard(row: ClusterRow): InfoCard {
  return {
    ...base,
    type: 'outage_report',
    id: `${row.tenant_id}:${row.locality_id ?? 'area'}:${row.utility_code}`,
    tenantId: row.tenant_id,
    title: { bn: row.area_bn, en: row.area_en },
    summary: String(row.reporters),
    badges: [row.utility_code, 'ongoing', 'reported'],
    startsAt: iso(row.first_at),
    updatedAt: iso(row.last_at),
    distanceMeters: meters(row.distance_m),
  };
}

export function noticeCard(row: NoticeRow): InfoCard {
  return {
    ...base,
    type: 'notice',
    id: row.id,
    tenantId: row.tenant_id,
    title: { bn: row.title, en: row.title },
    summary: row.template_code ? null : snippet(row.body),
    badges: [
      row.notice_type_code,
      row.category_code,
      ...(row.template_code ? [row.template_code] : []),
      ...(row.is_official ? ['official'] : []),
      ...(row.is_pinned ? ['pinned'] : []),
      ...(row.attachments > 0 ? ['attachment'] : []),
    ],
    startsAt: iso(row.event_starts_at ?? row.valid_from ?? row.published_at),
    endsAt: iso(row.event_ends_at ?? row.expires_at),
    updatedAt: iso(row.updated_at),
    distanceMeters: meters(row.distance_m),
  };
}

export function lostFoundCard(row: LostFoundRow, image: InfoCard['image']): InfoCard {
  return {
    ...base,
    type: 'lost_found',
    id: row.id,
    tenantId: row.tenant_id,
    title: { bn: row.title, en: row.title },
    summary: snippet(row.location_text ?? row.description),
    badges: [row.kind_code, row.item_type_code, ...(row.reward_amount ? ['reward'] : [])],
    startsAt: iso(row.last_seen_at ?? row.created_at),
    updatedAt: iso(row.updated_at),
    distanceMeters: meters(row.distance_m),
    location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
    image,
  };
}

export function routeCard(row: RouteRow, staleDays: number, now: Date): InfoCard {
  return {
    ...base,
    type: 'transport',
    id: row.id,
    tenantId: row.tenant_id,
    title: { bn: row.name_bn, en: row.name_en },
    summary: [row.origin_name, row.destination_name].join(' → '),
    badges: [row.mode_code, ...(row.operator_name ? ['operator'] : [])],
    updatedAt: iso(latest(row.last_verified_at, row.updated_at)),
    isStale: isStale(row.last_verified_at, staleDays, now),
    distanceMeters: meters(row.distance_m),
  };
}

export function govCard(row: GovRow, staleDays: number, now: Date): InfoCard {
  return {
    ...base,
    type: 'gov_service',
    id: row.id,
    tenantId: row.tenant_id,
    title: { bn: row.name_bn, en: row.name_en },
    summary: row.summary_bn ?? row.office_name,
    badges: [row.category_code, ...(row.is_active ? [] : ['inactive'])],
    updatedAt: `${row.last_verified_on}T00:00:00.000Z`,
    isStale: isStale(`${row.last_verified_on}T00:00:00.000Z`, staleDays, now),
    location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
  };
}

export function directoryCard(
  row: DirectoryRow,
  staleDays: number,
  now: Date,
  open: { state: string } | undefined,
): InfoCard {
  return {
    ...base,
    type: 'directory',
    id: row.id,
    tenantId: row.tenant_id,
    title: { bn: row.name_bn, en: row.name_en },
    summary: row.address,
    badges: [
      row.category_slug,
      ...(row.subtype ? [row.subtype] : []),
      ...(row.is_24h ? ['24h'] : []),
      ...(open && open.state !== 'unknown' ? [`open_state:${open.state}`] : []),
      ...(row.verified_at ? ['field_verified'] : []),
    ],
    updatedAt: iso(latest(row.verified_at, row.updated_at)),
    isStale: isStale(latest(row.verified_at, row.updated_at), staleDays, now),
    distanceMeters: meters(row.distance_m),
    location: { lat: row.lat, lng: row.lng },
  };
}

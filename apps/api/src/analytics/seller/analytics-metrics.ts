/**
 * The seller metrics (ADR 055): one vocabulary for the Redis counters, the
 * analytics_daily rows and the API. Whole numbers only.
 */

export const CONTACT_CHANNELS = ['call', 'whatsapp', 'sms', 'chat'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** lead_channels codes (0009) → the dashboard's contact channels. Others (directions…) aren't contacts. */
export const LEAD_CHANNEL_TO_CONTACT: Record<string, ContactChannel> = {
  call_click: 'call',
  whatsapp_click: 'whatsapp',
  sms_click: 'sms',
  chat_started: 'chat',
};

/** Fields of a day's counter hash and of analytics_daily.metrics. */
export const COUNTER_FIELDS = [
  'views',
  'saves',
  'share_opens',
  'search_appearances',
  'map_taps',
  'contacts_call',
  'contacts_whatsapp',
  'contacts_sms',
  'contacts_chat',
] as const;
export type CounterField = (typeof COUNTER_FIELDS)[number];

/** Stored per day besides the counters: the day's sketches, counted at rollup. */
export const UNIQUE_FIELDS = ['unique_viewers', 'unique_contacters'] as const;
export type UniqueField = (typeof UNIQUE_FIELDS)[number];

export type DayMetrics = Partial<Record<CounterField | UniqueField, number>>;

export function contactField(channel: ContactChannel): CounterField {
  return `contacts_${channel}`;
}

/** Only known fields, only whole non-negative numbers (a jsonb row or a Redis hash). */
export function cleanMetrics(raw: Record<string, unknown> | null | undefined): DayMetrics {
  const out: DayMetrics = {};
  if (!raw) return out;
  for (const field of [...COUNTER_FIELDS, ...UNIQUE_FIELDS]) {
    const n = Number(raw[field]);
    if (Number.isInteger(n) && n > 0) out[field] = n;
  }
  return out;
}

/** Adds `b` into `a` (counters and the per-day unique counts alike). */
export function addMetrics(a: DayMetrics, b: DayMetrics): DayMetrics {
  const out: DayMetrics = { ...a };
  for (const [field, value] of Object.entries(b) as [keyof DayMetrics, number][]) {
    out[field] = (out[field] ?? 0) + value;
  }
  return out;
}

export function contactsOf(m: DayMetrics): number {
  return CONTACT_CHANNELS.reduce((sum, channel) => sum + (m[contactField(channel)] ?? 0), 0);
}

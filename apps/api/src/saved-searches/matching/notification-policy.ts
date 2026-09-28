/**
 * When a saved search with new matches may notify (ADR 041). Pure, so every
 * rule is unit-tested:
 *
 *  - `off` never notifies (the matches still show as new results and badge);
 *  - at most `perDay` notifications per search per Asia/Dhaka day
 *    (saved_search_notify_per_day; 0 = none) — matches over the cap wait and
 *    go out grouped in the next allowed notification;
 *  - `instant`: whenever the cap allows;
 *  - `daily`: once a day, from `digestHour` Dhaka time
 *    (saved_search_daily_digest_hour).
 */

const DHAKA = 'Asia/Dhaka';

export interface DhakaTime {
  /** YYYY-MM-DD */
  day: string;
  hour: number;
}

export function dhakaTime(at: Date): DhakaTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DHAKA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

export interface NotifyState {
  alert_frequency_code: 'instant' | 'daily' | 'off';
  last_alerted_at: Date | null;
  /** Dhaka day of notify_count (YYYY-MM-DD). */
  notify_day: string | null;
  notify_count: number;
}

export function notificationDue(
  search: NotifyState,
  now: Date,
  limits: { perDay: number; digestHour: number },
): boolean {
  if (search.alert_frequency_code === 'off') return false;
  const today = dhakaTime(now);
  const sentToday = search.notify_day === today.day ? search.notify_count : 0;
  if (sentToday >= limits.perDay) return false;
  if (search.alert_frequency_code === 'instant') return true;
  const lastDay = search.last_alerted_at === null ? null : dhakaTime(search.last_alerted_at).day;
  return today.hour >= limits.digestHour && lastDay !== today.day;
}

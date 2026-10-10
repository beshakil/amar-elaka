import type { ChannelCode, InterruptChannel } from './notification-channel';

/**
 * Who gets what, when (ADR 059). Pure, so every rule is unit-tested; the
 * dispatcher feeds it the type's row, the user's preferences, the settings.
 */

/** A notification type's delivery behaviour (notification_types, 0055). */
export interface TypeRules {
  code: string;
  defaultChannels: readonly ChannelCode[];
  /** Security and account notices: no quiet hours, no caps. */
  urgent: boolean;
  smsEligible: boolean;
  collapsible: boolean;
  userConfigurable: boolean;
}

export interface RecipientFacts {
  hasVerifiedPhone: boolean;
  hasVerifiedEmail: boolean;
  pushDevices: number;
}

/**
 * The interrupting channels a notification takes:
 *  - the type's defaults, switched on or off by the user's preference for
 *    (type, channel) — unless the type isn't user-configurable;
 *  - SMS only for an SMS-eligible type or one a platform admin listed in
 *    notification_sms_extra_types (SMS costs money), and a verified phone;
 *  - email only to a verified address; push only to a registered device.
 * The in-app inbox isn't a choice: every notification is in it.
 */
export function chooseChannels(
  rules: TypeRules,
  preferences: ReadonlyMap<ChannelCode, boolean>,
  recipient: RecipientFacts,
  smsExtraTypes: readonly string[],
): InterruptChannel[] {
  const smsAllowed = rules.smsEligible || smsExtraTypes.includes(rules.code);
  const wanted = (channel: InterruptChannel): boolean => {
    const byDefault = rules.defaultChannels.includes(channel);
    if (!rules.userConfigurable) return byDefault;
    return preferences.get(channel) ?? byDefault;
  };
  const chosen: InterruptChannel[] = [];
  if (wanted('push') && recipient.pushDevices > 0) chosen.push('push');
  if (smsAllowed && wanted('sms') && recipient.hasVerifiedPhone) chosen.push('sms');
  if (wanted('email') && recipient.hasVerifiedEmail) chosen.push('email');
  return chosen;
}

/** Which channels a user may switch for a type (the preferences API). */
export function configurableChannels(
  rules: TypeRules,
  smsExtraTypes: readonly string[],
): InterruptChannel[] {
  if (!rules.userConfigurable) return [];
  const channels: InterruptChannel[] = ['push', 'email'];
  if (rules.smsEligible || smsExtraTypes.includes(rules.code)) channels.push('sms');
  return channels;
}

// settings-exempt: unit conversions
const MINUTES_PER_HOUR = 60;
// settings-exempt: see above
const MS_PER_MINUTE = 60_000;
// settings-exempt: see above
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

function minutesOf(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return (h ?? 0) * MINUTES_PER_HOUR + (m ?? 0);
}

/** The wall-clock minute of the day at `at` in `timeZone`. */
function localMinute(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * MINUTES_PER_HOUR + get('minute');
}

/**
 * When quiet hours that are on at `now` end, or null when they're off.
 * `start`/`end` are HH:MM in `timeZone` (the tenant's, Asia/Dhaka by
 * default); the window may wrap midnight (22:00–08:00). start = end means no
 * quiet hours.
 */
export function quietHoursEnd(
  now: Date,
  start: string,
  end: string,
  timeZone: string,
): Date | null {
  const from = minutesOf(start);
  const to = minutesOf(end);
  if (from === to) return null;
  const minute = localMinute(now, timeZone);
  const inside = from < to ? minute >= from && minute < to : minute >= from || minute < to;
  if (!inside) return null;
  const minutesLeft = (to - minute + MINUTES_PER_DAY) % MINUTES_PER_DAY || MINUTES_PER_DAY;
  const at = new Date(now.getTime() + minutesLeft * MS_PER_MINUTE);
  // Land on the minute itself (drop the seconds now carried).
  return new Date(Math.floor(at.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE);
}

/** The start of `at`'s day in `timeZone`, as an instant (the caps count from it). */
export function startOfLocalDay(at: Date, timeZone: string): Date {
  const intoMinute = at.getTime() % MS_PER_MINUTE;
  return new Date(at.getTime() - localMinute(at, timeZone) * MS_PER_MINUTE - intoMinute);
}

/**
 * Caps on interruptions (push, SMS, email) for one user today: all types
 * together (notification_daily_cap) and this type (notification_type_daily_caps;
 * a type not listed has no cap of its own). Urgent types are never capped.
 * Over a cap, the notification stays in the in-app inbox only.
 */
export function overCap(
  rules: TypeRules,
  sentToday: { all: number; ofType: number },
  caps: { daily: number; perType: Readonly<Record<string, number>> },
): boolean {
  if (rules.urgent) return false;
  if (sentToday.all >= caps.daily) return true;
  const typeCap = caps.perType[rules.code];
  return typeCap !== undefined && sentToday.ofType >= typeCap;
}

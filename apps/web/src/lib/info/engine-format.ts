import { localizeDigits } from '@amar-elaka/dynamic-form';
import type { InfoCard } from '../api/schemas';

/**
 * The info engine's card, in words (ADR 065): where a card opens, its time
 * line, its distance. Pure — the pages pass the area's timezone.
 */

// settings-exempt: unit conversion
const METRES_PER_KM = 1000;

/** Where a card opens on the web; null = it says it all (an outage). */
export function infoHref(card: InfoCard): string | null {
  switch (card.type) {
    case 'notice':
      return `/info/notices/${card.id}`;
    case 'lost_found':
      return `/info/lost-found/${card.id}`;
    case 'transport':
      return `/info/transport/${card.id}`;
    case 'gov_service':
      return `/info/gov/${card.id}`;
    case 'directory':
      return card.location
        ? `/map?lat=${card.location.lat.toFixed(5)}&lng=${card.location.lng.toFixed(5)}&z=17`
        : null;
    default:
      return null;
  }
}

/** "৮২০ মি" / "১.৫ কিমি" — bn digits. */
export function distanceText(
  metres: number | null,
  words: { m: (d: string) => string; km: (d: string) => string },
): string | null {
  if (metres === null) return null;
  if (metres < METRES_PER_KM) return words.m(localizeDigits(String(Math.round(metres)), 'bn'));
  return words.km(localizeDigits((metres / METRES_PER_KM).toFixed(1), 'bn'));
}

export function moment(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('bn-BD', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    dayPeriod: 'short',
  }).format(new Date(iso));
}

export function day(iso: string, timeZone: string): string {
  const at = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat('bn-BD', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(at);
}

/**
 * "৪:৪১ ভোর": `dayPeriod` gives Bengali periods (ভোর, সকাল, দুপুর, বিকাল,
 * সন্ধ্যা, রাত্রি); a plain 12-hour bn-BD format prints English "AM"/"PM".
 */
export function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('bn-BD', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    dayPeriod: 'short',
  }).format(new Date(iso));
}

/** The card's time line: an outage's window, last seen, a notice's date, or "updated". */
export function infoWhen(
  card: InfoCard,
  timeZone: string,
  words: {
    window: (from: string, to: string) => string;
    lastSeen: (when: string) => string;
    updated: (date: string) => string;
  },
): string | null {
  if (card.type === 'outage' && card.startsAt && card.endsAt) {
    return words.window(moment(card.startsAt, timeZone), moment(card.endsAt, timeZone));
  }
  if (card.type === 'lost_found' && card.startsAt)
    return words.lastSeen(moment(card.startsAt, timeZone));
  if (card.type === 'notice' && card.startsAt) return moment(card.startsAt, timeZone);
  if (card.updatedAt && ['transport', 'gov_service', 'directory'].includes(card.type)) {
    return words.updated(day(card.updatedAt, timeZone));
  }
  return null;
}

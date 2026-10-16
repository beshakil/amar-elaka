/**
 * Form helpers for the info engine pages (ADR 065), kept pure (unit-tested):
 * `<input type="datetime-local">` speaks the phone's local time; the API
 * takes instants. Lines → lists for the phone-friendly textareas.
 */

/** "2026-10-16T09:30" (the device's time) → an ISO instant, or null. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** An instant → "2026-10-16T09:30" in the device's time. */
export function toLocalInput(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** One item per non-empty line. */
export function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** "label | amount" lines; a line without both parts is dropped. */
export function pairs(text: string): { label: string; value: string }[] {
  return lines(text).flatMap((line) => {
    const [label, value] = line.split('|').map((part) => part.trim());
    return label && value ? [{ label, value }] : [];
  });
}

/** "23.81, 90.41" → a point, or null. */
export function parsePoint(text: string): { lat: number; lng: number } | null {
  const [lat, lng] = text.split(',').map((v) => Number(v.trim()));
  return text.trim() && Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat: lat!, lng: lng! }
    : null;
}

/** Bengali digits (a phone keyboard may type them) → ASCII. */
export function asciiDigits(text: string): string {
  return text.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09e6));
}

/** A stop line: "name | minutes | fare" (minutes and fare optional). */
export function parseStops(
  text: string,
): { nameBn: string; minutesFromOrigin: number | null; fareFromOrigin: string | null }[] {
  return lines(asciiDigits(text)).map((line) => {
    const [name = '', minutes = '', fare = ''] = line.split('|').map((p) => p.trim());
    const m = Number(minutes);
    return {
      nameBn: name,
      minutesFromOrigin: minutes && Number.isInteger(m) && m >= 0 ? m : null,
      fareFromOrigin: fare || null,
    };
  });
}

export function formatStops(
  stops: {
    name: { bn: string | null };
    minutesFromOrigin: number | null;
    fareFromOrigin: string | null;
  }[],
): string {
  return stops
    .map((s) =>
      [s.name.bn ?? '', s.minutesFromOrigin ?? '', s.fareFromOrigin ?? '']
        .join(' | ')
        .replace(/( \| )+$/, ''),
    )
    .join('\n');
}

// settings-exempt: ISO weekdays Monday = 1 … Sunday = 7 (a calendar fact)
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** A departure line: "07:30 | days | fare | class" — days as digits (1 = Monday), blank = every day. */
export function parseDepartures(
  text: string,
  direction: 'outbound' | 'return',
): {
  direction: 'outbound' | 'return';
  departureTime: string;
  days: number[];
  fare: string | null;
  serviceClass: string | null;
}[] {
  return lines(asciiDigits(text)).map((line) => {
    const [time = '', days = '', fare = '', serviceClass = ''] = line
      .split('|')
      .map((p) => p.trim());
    const [h = '', m = ''] = time.replace('.', ':').split(':');
    const picked = [...new Set([...days].map(Number).filter((d) => d >= 1 && d <= 7))].sort();
    return {
      direction,
      departureTime: `${h.padStart(2, '0')}:${m.padStart(2, '0')}`,
      days: picked.length > 0 ? picked : ALL_DAYS,
      fare: fare || null,
      serviceClass: serviceClass || null,
    };
  });
}

export function formatDepartures(
  schedules: {
    direction: string;
    departureTime: string;
    days: number[];
    fare: string | null;
    serviceClass: string | null;
  }[],
  direction: 'outbound' | 'return',
): string {
  return schedules
    .filter((s) => s.direction === direction)
    .map((s) =>
      [
        s.departureTime.slice(0, 5),
        s.days.length === ALL_DAYS.length ? '' : s.days.join(''),
        s.fare ?? '',
        s.serviceClass ?? '',
      ]
        .join(' | ')
        .replace(/( \| )+$/, ''),
    )
    .join('\n');
}

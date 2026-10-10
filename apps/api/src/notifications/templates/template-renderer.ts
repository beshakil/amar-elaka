import { bengaliDigits, groupSouthAsian } from '../../common/text/bengali-numerals';
import { SCHEDULE_TIMEZONE } from '../../common/schedule-timezone';

export type Locale = 'bn' | 'en';
export type TemplateVars = Record<string, string | null | undefined>;

// settings-exempt: paisa are two digits — a fact of the currency
const PAISA_DIGITS = 2;

/**
 * Renders a notification template (notification_templates, ADR 059). The
 * texts live in the database, Bengali first; this only fills them in:
 *
 *   {{name}}             the value as is (titles, names — never re-digited)
 *   {{name|number}}      a count in the locale's digits: "৪", "১,২৪০"
 *   {{name|taka}}        money ("12000.00") as "৳১২,০০০" / "Tk 12,000"
 *   {{name|date}}        an ISO time as a day and month, Asia/Dhaka: "১২ অক্টোবর"
 *   {{#name}}…{{/name}}  only when the value is there (not empty, not "0", not "false")
 *   {{^name}}…{{/name}}  only when it isn't
 *
 * A missing variable renders as nothing; an unknown filter as the raw value.
 * Sections nest (different names).
 */
export function renderTemplate(template: string, vars: TemplateVars, locale: Locale): string {
  // Outer sections first, then whatever they left inside, until none remain.
  let withSections = template;
  for (;;) {
    const next = withSections.replace(
      /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
      (_match, kind: string, name: string, inner: string) =>
        present(vars[name]) === (kind === '#') ? inner : '',
    );
    if (next === withSections) break;
    withSections = next;
  }
  return withSections.replace(
    /\{\{(\w+)(?:\|(\w+))?\}\}/g,
    (_match, name: string, filter?: string) => {
      const value = vars[name];
      if (value === null || value === undefined) return '';
      switch (filter) {
        case 'number':
          return formatCount(value, locale);
        case 'taka':
          return formatTaka(value, locale);
        case 'date':
          return formatDate(value, locale);
        default:
          return value;
      }
    },
  );
}

function present(value: string | null | undefined): boolean {
  return (
    value !== null && value !== undefined && value !== '' && value !== '0' && value !== 'false'
  );
}

function digits(text: string, locale: Locale): string {
  return locale === 'bn' ? bengaliDigits(text) : text;
}

/** "4" → "৪"; "1240" → "১,২৪০" (South Asian grouping); anything else as is. */
export function formatCount(value: string, locale: Locale): string {
  if (!/^\d+$/.test(value)) return value;
  return digits(groupSouthAsian(value), locale);
}

/** "12000.00" → "৳১২,০০০"; paisa kept only when there are some ("৳৯৯.৫০"). */
export function formatTaka(value: string, locale: Locale): string {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return value;
  const [, whole, fraction] = match;
  const paisa = (fraction ?? '').padEnd(PAISA_DIGITS, '0');
  const amount = `${groupSouthAsian(whole!)}${paisa === '00' ? '' : `.${paisa}`}`;
  return locale === 'bn' ? `৳${digits(amount, locale)}` : `Tk ${amount}`;
}

/** An ISO time as "১২ অক্টোবর" / "12 October", in Asia/Dhaka. */
export function formatDate(value: string, locale: Locale): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: SCHEDULE_TIMEZONE,
  }).format(at);
}

import { text } from '../text';
import {
  formFieldKeys,
  formatMoney,
  labelOf,
  localizeDigits,
  optionLabel,
  parseMoneyInput,
  type CategoryFieldSchema,
  type Locale,
} from '@amar-elaka/dynamic-form';

/**
 * A stored field value as a reader sees it — option labels, Bengali digits,
 * grouped money — for the card and the preview (the web twin of the mobile
 * app's field_display.dart). Null when there's nothing to show.
 */
export function displayValue(
  schema: CategoryFieldSchema,
  key: string,
  value: unknown,
  locale: Locale,
  yesNo: { yes: string; no: string },
): string | null {
  const property = schema.jsonSchema.properties[key];
  if (!property || value === undefined || value === null || value === '') return null;
  switch (property['x-field-type']) {
    case 'select':
      return optionLabel(schema, key, text(value), locale);
    case 'multiselect':
      return Array.isArray(value) && value.length > 0
        ? value.map((code) => optionLabel(schema, key, text(code), locale)).join(', ')
        : null;
    case 'bool':
      return value === true ? yesNo.yes : yesNo.no;
    case 'money':
      return `৳ ${formatMoney(parseMoneyInput(text(value)) ?? text(value), locale)}`;
    case 'phone':
      return localizeDigits(text(value).replace(/^\+88/, ''), locale);
    default:
      return localizeDigits(text(value), locale);
  }
}

/** The card's facts: price, and the category's card fields as "label value". */
export function cardFacts(
  schema: CategoryFieldSchema | null,
  values: Record<string, unknown>,
  locale: Locale,
  yesNo: { yes: string; no: string },
): { price: string | null; attributes: string[] } {
  if (!schema) return { price: null, attributes: [] };
  const attributes = formFieldKeys(schema)
    .filter((key) => key !== 'price' && schema.uiSchema.card.includes(key))
    .flatMap((key) => {
      const shown = displayValue(schema, key, values[key], locale, yesNo);
      return shown ? [`${labelOf(schema, key, locale)} ${shown}`] : [];
    });
  return { price: displayValue(schema, 'price', values.price, locale, yesNo), attributes };
}

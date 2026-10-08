import type {
  FieldProperty,
  FieldSchema,
  FieldValue,
  FieldValues,
  UiSchema,
} from '../../categories/field-schema';
import { bengaliDigits } from '../../common/text/bengali-numerals';
import { IMPORT_TEXT, imageHeader } from './import.templates';

/**
 * A bulk-import sheet's columns (ADR 056): the post's title and description,
 * the category's own fields (its form, in its order, Bengali labels), then
 * one column per photo. The template writes them; an uploaded sheet is read
 * back through them — by header, in any order, Bengali or English label or
 * the field's key, so a seller may reorder or translate columns.
 */

export type ImportColumn =
  | { kind: 'title'; header: string; required: true }
  | { kind: 'description'; header: string; required: false }
  | {
      kind: 'field';
      key: string;
      header: string;
      required: boolean;
      property: FieldProperty;
      aliases: string[];
    }
  | { kind: 'image'; index: number; header: string; required: false };

/** A field the seller fills: shown on its form, and a type a cell can carry. */
function formFields(schema: FieldSchema, ui: UiSchema): string[] {
  const hidden = new Set(ui.hidden ?? []);
  const ordered = [
    ...ui.order,
    ...Object.keys(schema.properties).filter((k) => !ui.order.includes(k)),
  ];
  return [...new Set(ordered)].filter((key) => schema.properties[key] && !hidden.has(key));
}

export function importColumns(
  schema: FieldSchema,
  ui: UiSchema,
  maxImages: number,
): ImportColumn[] {
  const required = new Set(schema.required);
  const mark = (label: string, isRequired: boolean) => (isRequired ? `${label} *` : label);
  return [
    { kind: 'title', header: mark(IMPORT_TEXT.title, true), required: true },
    { kind: 'description', header: IMPORT_TEXT.description, required: false },
    ...formFields(schema, ui).map((key): ImportColumn => {
      const label = ui.labels[key];
      return {
        kind: 'field',
        key,
        header: mark(label?.bn ?? key, required.has(key)),
        required: required.has(key),
        property: schema.properties[key]!,
        aliases: [key, label?.en ?? '', label?.bn ?? ''].filter(Boolean),
      };
    }),
    ...Array.from({ length: maxImages }, (_, i): ImportColumn => ({
      kind: 'image',
      index: i,
      header: imageHeader(i + 1),
      required: false,
    })),
  ];
}

/** Header text as a key: trimmed, no required-star, lower case, single spaces. */
export function normalizeHeader(text: string): string {
  return text.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function aliasesOf(column: ImportColumn): string[] {
  switch (column.kind) {
    case 'title':
      return [column.header, IMPORT_TEXT.titleEn, 'title'];
    case 'description':
      return [column.header, IMPORT_TEXT.descriptionEn, 'description'];
    case 'field':
      return [column.header, ...column.aliases];
    case 'image':
      return [
        column.header,
        `image ${column.index + 1}`,
        `image_${column.index + 1}`,
        `ছবি ${column.index + 1}`,
      ];
  }
}

/** Which column each header cell is (undefined: an unknown column, ignored). */
export function matchHeaders(
  headers: readonly string[],
  columns: readonly ImportColumn[],
): (ImportColumn | undefined)[] {
  const lookup = new Map<string, ImportColumn>();
  for (const column of columns) {
    for (const alias of aliasesOf(column)) lookup.set(normalizeHeader(alias), column);
  }
  return headers.map((header) => lookup.get(normalizeHeader(header)));
}

// ---- cells → values -----------------------------------------------------------------

const BENGALI_DIGIT = /[০-৯]/g;
const toAsciiDigits = (text: string) =>
  text.replace(BENGALI_DIGIT, (d) => String(d.charCodeAt(0) - '০'.charCodeAt(0)));

const TRUE_WORDS = new Set(['হ্যাঁ', 'হ্যা', 'yes', 'y', 'true', '1', 'আছে']);
const FALSE_WORDS = new Set(['না', 'no', 'n', 'false', '0', 'নেই']);

// settings-exempt: the spreadsheet date epoch (serial 0 = 1899-12-30) and a day's milliseconds
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
// settings-exempt: see above
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// settings-exempt: money keeps two decimals (paisa)
const MONEY_DECIMALS = 2;
// settings-exempt: the length of an ISO date (YYYY-MM-DD)
const ISO_DATE_CHARS = 10;
// settings-exempt: how many options a template's example multiselect cell shows
const EXAMPLE_OPTIONS = 2;

export class CellError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
  }
}

function optionCode(property: FieldProperty, ui: UiSchema, key: string, cell: string): string {
  const options =
    property['x-field-type'] === 'multiselect'
      ? property.items.enum
      : property['x-field-type'] === 'select'
        ? property.enum
        : [];
  const wanted = normalizeHeader(cell);
  for (const code of options) {
    const label = ui.options?.[key]?.[code];
    if ([code, label?.bn, label?.en].some((v) => v !== undefined && normalizeHeader(v) === wanted))
      return code;
  }
  throw new CellError(
    'unknown_option',
    IMPORT_TEXT.unknownOption(
      cell,
      options.map((c) => ui.options?.[key]?.[c]?.bn ?? c),
    ),
  );
}

/** "১,৫০০" / "৳ 1500.5" → "1500.50"; no float on the way. */
export function moneyFromCell(cell: string): string {
  const plain = toAsciiDigits(cell)
    .replace(/[৳,\s]/g, '')
    .replace(/^tk\.?/i, '');
  const parts = /^(?<whole>\d+)(?:\.(?<fraction>\d{1,2}))?$/.exec(plain)?.groups;
  if (!parts) throw new CellError('invalid_money', IMPORT_TEXT.invalidMoney(cell));
  return `${parts.whole!.replace(/^0+(?=\d)/, '')}.${(parts.fraction ?? '').padEnd(MONEY_DECIMALS, '0')}`;
}

/** One cell as its field's value; undefined for an empty cell. */
export function fieldValue(
  column: Extract<ImportColumn, { kind: 'field' }>,
  ui: UiSchema,
  raw: string,
): FieldValue | undefined {
  const cell = raw.trim();
  if (cell === '') return undefined;
  const property = column.property;
  switch (property['x-field-type']) {
    case 'text':
    case 'textarea':
    case 'phone':
      return cell;
    case 'number': {
      const n = Number(toAsciiDigits(cell).replace(/,/g, ''));
      if (!Number.isFinite(n))
        throw new CellError('invalid_number', IMPORT_TEXT.invalidNumber(cell));
      return n;
    }
    case 'money':
      return moneyFromCell(cell);
    case 'bool': {
      const word = toAsciiDigits(cell).toLowerCase();
      if (TRUE_WORDS.has(word)) return true;
      if (FALSE_WORDS.has(word)) return false;
      throw new CellError('invalid_yes_no', IMPORT_TEXT.invalidYesNo(cell));
    }
    case 'select':
      return optionCode(property, ui, column.key, cell);
    case 'multiselect':
      return [
        ...new Set(
          cell
            .split(/[,;।]/)
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => optionCode(property, ui, column.key, part)),
        ),
      ];
    case 'date': {
      const ascii = toAsciiDigits(cell);
      if (/^\d{4}-\d{2}-\d{2}$/.test(ascii)) return ascii;
      // A spreadsheet date the sheet kept as its serial number.
      if (/^\d+(\.\d+)?$/.test(ascii)) {
        return new Date(EXCEL_EPOCH + Math.floor(Number(ascii)) * MS_PER_DAY)
          .toISOString()
          .slice(0, ISO_DATE_CHARS);
      }
      throw new CellError('invalid_date', IMPORT_TEXT.invalidDate(cell));
    }
  }
}

export interface ParsedRow {
  title: string;
  description: string | undefined;
  fields: FieldValues;
  images: string[];
}

/** A sheet row through the matched columns. Throws CellError naming the cell. */
export function parseRow(
  cells: readonly string[],
  matched: readonly (ImportColumn | undefined)[],
  ui: UiSchema,
): ParsedRow {
  const row: ParsedRow = { title: '', description: undefined, fields: {}, images: [] };
  for (const [i, column] of matched.entries()) {
    if (!column) continue;
    const cell = (cells[i] ?? '').trim();
    switch (column.kind) {
      case 'title':
        row.title = cell;
        break;
      case 'description':
        row.description = cell === '' ? undefined : cell;
        break;
      case 'image':
        if (cell !== '') row.images.push(cell);
        break;
      case 'field':
        try {
          const value = fieldValue(column, ui, cell);
          if (value !== undefined) row.fields[column.key] = value;
        } catch (error) {
          if (error instanceof CellError)
            throw new CellError(error.reasonCode, `${column.header}: ${error.message}`);
          throw error;
        }
    }
  }
  if (row.title === '') throw new CellError('missing_title', IMPORT_TEXT.missingTitle);
  return row;
}

/** A plausible example value per field (the template's second row). */
export function exampleValue(
  column: Extract<ImportColumn, { kind: 'field' }>,
  ui: UiSchema,
): string {
  const property = column.property;
  switch (property['x-field-type']) {
    case 'text':
      return IMPORT_TEXT.exampleText;
    case 'textarea':
      return IMPORT_TEXT.exampleTextarea;
    case 'phone':
      return IMPORT_TEXT.examplePhone;
    case 'number':
      return bengaliDigits(
        String(
          property.minimum ??
            (property.exclusiveMinimum !== undefined ? property.exclusiveMinimum + 1 : 1),
        ),
      );
    case 'money':
      return property['x-money-min'] ?? IMPORT_TEXT.exampleMoney;
    case 'bool':
      return IMPORT_TEXT.yes;
    case 'select': {
      const code = property.enum[0] ?? '';
      return ui.options?.[column.key]?.[code]?.bn ?? code;
    }
    case 'multiselect':
      return property.items.enum
        .slice(0, EXAMPLE_OPTIONS)
        .map((code) => ui.options?.[column.key]?.[code]?.bn ?? code)
        .join(', ');
    case 'date':
      return IMPORT_TEXT.exampleDate;
  }
}

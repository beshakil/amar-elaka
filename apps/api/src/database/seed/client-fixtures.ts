import {
  compileFieldsValidator,
  fieldIssuesOf,
  type FieldIssueCode,
  type FieldsValidationContext,
} from '../../categories/field-schema';
import { CATEGORIES } from './data/categories';
import { definitionOf } from './data/category-dsl';

/**
 * Fixtures the clients' dynamic form renderers are built and tested against,
 * generated from the seed taxonomy so the clients never drift from it:
 *
 *   - `<slug>.json`: a category as GET /categories serves it (the demo screens
 *     render these).
 *   - `validation-cases.json`: payloads and the issues the *server* validator
 *     reports for each. The React zod builder and the Dart validator must
 *     report exactly the same, which is what "client validation mirrors the
 *     server" means in practice.
 *
 * `pnpm fixtures:export` writes them; client-fixtures.spec.ts fails when a
 * committed copy is stale.
 */

export const FIXTURE_CATEGORIES = ['to-let', 'rent-a-car'] as const;

/** Fixed, so the date and model-year cases give the same answer on every day. */
export const FIXTURE_CONTEXT: FieldsValidationContext = { today: '2026-09-24', currentYear: 2026 };

/** Where each client keeps the fixtures, relative to the repository root. */
export const FIXTURE_DIRS = [
  'packages/dynamic-form/fixtures',
  'apps/mobile/test/fixtures',
] as const;
export const DART_DEMO_FILE = 'apps/mobile/lib/features/form_preview/demo_category_schemas.g.dart';

interface Case {
  category: (typeof FIXTURE_CATEGORIES)[number];
  name: string;
  values: Record<string, unknown>;
}

const toLetValid = {
  property_type: 'flat',
  tenant_type: 'family',
  bedrooms: 3,
  bathrooms: 2,
  floor: 4,
  total_floors: 6,
  area: 1250,
  price: '15000.00',
  advance_months: 2,
  available_from: '2026-10-01',
  gas_supply: 'pipeline',
  has_lift: true,
};

const rentACarValid = {
  vehicle_type: 'microbus',
  seats: 11,
  ac: true,
  driver_option: 'with_driver',
  price: '6500.00',
  rate_per_hour: '800.00',
  driver_allowance_included: false,
  trip_types: ['local', 'airport'],
  model_year: 2019,
};

const CASES: Case[] = [
  { category: 'to-let', name: 'a complete flat listing', values: toLetValid },
  { category: 'to-let', name: 'nothing filled in', values: {} },
  {
    category: 'to-let',
    name: 'a flat without its conditional required fields',
    values: { property_type: 'flat', price: '9000.00', available_from: '2026-09-24' },
  },
  {
    category: 'to-let',
    name: 'a shop needs no bedrooms, and must not send them',
    values: { property_type: 'shop', price: '9000.00', available_from: '2026-09-30', bedrooms: 1 },
  },
  {
    category: 'to-let',
    name: 'wrong types',
    values: { ...toLetValid, bedrooms: 'two', price: 15000, has_lift: 'yes', advance_months: 1.5 },
  },
  {
    category: 'to-let',
    name: 'out of range',
    values: { ...toLetValid, bedrooms: 21, floor: -3, price: '99.99', area: 100001 },
  },
  {
    category: 'to-let',
    name: 'not an option, and an unknown key',
    values: { ...toLetValid, gas_supply: 'solar', furnishing: 'luxury', gym: true },
  },
  {
    category: 'to-let',
    name: 'a date in the past',
    values: { ...toLetValid, available_from: '2026-09-23' },
  },
  {
    category: 'to-let',
    name: 'an impossible calendar day',
    values: { ...toLetValid, available_from: '2026-02-30' },
  },
  {
    category: 'to-let',
    name: 'total floors below the floor',
    values: { ...toLetValid, floor: 7, total_floors: 6 },
  },
  {
    category: 'to-let',
    name: 'malformed amounts',
    values: { ...toLetValid, price: '15,000', advance_amount: '1e5', service_charge: '500.5' },
  },
  { category: 'rent-a-car', name: 'a complete microbus listing', values: rentACarValid },
  { category: 'rent-a-car', name: 'nothing filled in', values: {} },
  {
    category: 'rent-a-car',
    name: 'self-drive hides the driver allowance',
    values: { ...rentACarValid, driver_option: 'self_drive', driver_allowance_included: true },
  },
  {
    category: 'rent-a-car',
    name: 'model year beyond next year, and too few seats',
    values: { ...rentACarValid, model_year: 2028, seats: 0 },
  },
  {
    category: 'rent-a-car',
    name: 'multiselect: duplicate and unknown options',
    values: { ...rentACarValid, trip_types: ['local', 'local'] },
  },
  {
    category: 'rent-a-car',
    name: 'multiselect: unknown option',
    values: { ...rentACarValid, trip_types: ['moon'] },
  },
  {
    category: 'rent-a-car',
    name: 'hourly rate below its minimum',
    values: { ...rentACarValid, rate_per_hour: '5.00' },
  },
  {
    category: 'rent-a-car',
    name: 'text too long',
    values: { ...rentACarValid, brand: 'x'.repeat(41) },
  },
];

const byFieldThenCode = (a: FieldIssueCode, b: FieldIssueCode) =>
  a.field === b.field ? a.code.localeCompare(b.code) : a.field.localeCompare(b.field);

function categoryFixture(slug: string) {
  const def = CATEGORIES.find((c) => c.slug === slug)!;
  const definition = definitionOf(def, CATEGORIES);
  return {
    slug: def.slug,
    name: { bn: def.nameBn, en: def.nameEn },
    fieldSchema: {
      jsonSchema: definition.jsonSchema,
      uiSchema: definition.uiSchema,
      filterableFields: definition.filterableFields,
      searchableFields: definition.searchableFields,
    },
  };
}

function validationCases() {
  return {
    context: FIXTURE_CONTEXT,
    cases: CASES.map((c) => {
      const { jsonSchema } = definitionOf(
        CATEGORIES.find((d) => d.slug === c.category)!,
        CATEGORIES,
      );
      const result = compileFieldsValidator(jsonSchema, FIXTURE_CONTEXT).safeParse(c.values);
      const issues = result.success ? [] : fieldIssuesOf(result.error).sort(byFieldThenCode);
      return { ...c, issues };
    }),
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function dartDemoFile(categories: ReturnType<typeof categoryFixture>[]): string {
  const entries = categories.map((c) => `  '${c.slug}': r'''${JSON.stringify(c)}''',`).join('\n');
  return [
    '// GENERATED by `pnpm --filter @amar-elaka/api fixtures:export` from the',
    '// seed taxonomy (apps/api/src/database/seed/client-fixtures.ts). Do not edit.',
    '',
    '/// Category JSON (as GET /categories serves it) for the debug form preview.',
    'const Map<String, String> demoCategorySchemas = {',
    entries,
    '};',
    '',
  ].join('\n');
}

/** Every generated file, keyed by its path relative to the repository root. */
export function buildClientFixtures(): Record<string, string> {
  const categories = FIXTURE_CATEGORIES.map(categoryFixture);
  const files: Record<string, string> = {};
  for (const dir of FIXTURE_DIRS) {
    for (const category of categories) files[`${dir}/${category.slug}.json`] = json(category);
    files[`${dir}/validation-cases.json`] = json(validationCases());
  }
  files[DART_DEMO_FILE] = dartDemoFile(categories);
  return files;
}

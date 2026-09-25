import type { FieldSchema } from './field-schema.types';
import {
  compileFieldsValidator,
  FIELD_ISSUES,
  validationContextAt,
  visibleFields,
  type FieldsValidationContext,
} from './fields-validator';

const context: FieldsValidationContext = { today: '2026-09-24', currentYear: 2026 };

const schema: FieldSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    property_type: { 'x-field-type': 'select', type: 'string', enum: ['flat', 'shop'] },
    bedrooms: { 'x-field-type': 'number', type: 'integer', minimum: 0, maximum: 20 },
    floor: { 'x-field-type': 'number', type: 'integer', minimum: -2, maximum: 100 },
    total_floors: { 'x-field-type': 'number', type: 'integer', minimum: 1, 'x-gte-field': 'floor' },
    price: {
      'x-field-type': 'money',
      type: 'string',
      'x-money-min': '100.00',
      'x-money-max': '10000000.00',
    },
    salary_max: { 'x-field-type': 'money', type: 'string', 'x-gte-field': 'price' },
    has_lift: { 'x-field-type': 'bool', type: 'boolean' },
    days: {
      'x-field-type': 'multiselect',
      type: 'array',
      items: { type: 'string', enum: ['sat', 'sun'] },
      uniqueItems: true,
      minItems: 1,
    },
    available_from: {
      'x-field-type': 'date',
      type: 'string',
      format: 'date',
      'x-not-before-today': true,
    },
    model_year: {
      'x-field-type': 'number',
      type: 'integer',
      minimum: 1970,
      'x-max-current-year-offset': 1,
    },
    brand: { 'x-field-type': 'text', type: 'string', maxLength: 5 },
    eiin: { 'x-field-type': 'text', type: 'string', maxLength: 6, pattern: '^\\d{6}$' },
    portfolio_url: { 'x-field-type': 'text', type: 'string', maxLength: 300, format: 'uri' },
    serial_phone: { 'x-field-type': 'phone', type: 'string' },
    salary_period: { 'x-field-type': 'select', type: 'string', enum: ['monthly'] },
  },
  required: ['property_type', 'price'],
  allOf: [
    {
      if: { properties: { property_type: { enum: ['flat'] } }, required: ['property_type'] },
      then: { required: ['bedrooms'] },
    },
    { if: { required: ['salary_max'] }, then: { required: ['salary_period'] } },
  ],
};

const validate = (value: unknown) => compileFieldsValidator(schema, context).safeParse(value);

function issuesOf(value: unknown): Record<string, string> {
  const result = validate(value);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]));
}

const minimal = { property_type: 'shop', price: '8500.00' };

describe('compileFieldsValidator', () => {
  it('accepts a minimal valid value and returns it unchanged', () => {
    expect(validate(minimal)).toEqual({ success: true, data: minimal });
  });

  it('reports missing required fields and unknown keys with stable codes', () => {
    expect(issuesOf({ property_type: 'shop' })).toEqual({ price: FIELD_ISSUES.required });
    expect(validate({ ...minimal, nope: 1 }).success).toBe(false);
  });

  describe('money', () => {
    it('only accepts two-decimal strings, never JSON numbers', () => {
      expect(issuesOf({ ...minimal, price: 8500 })).toEqual({ price: FIELD_ISSUES.invalid });
      expect(issuesOf({ ...minimal, price: '8500' })).toEqual({ price: FIELD_ISSUES.invalid });
      expect(issuesOf({ ...minimal, price: '8500.5' })).toEqual({ price: FIELD_ISSUES.invalid });
    });

    it('reports a malformed amount once and never throws, even in a field comparison', () => {
      expect(issuesOf({ ...minimal, price: 'abc' })).toEqual({ price: FIELD_ISSUES.invalid });
      expect(issuesOf({ ...minimal, salary_max: '1e3', salary_period: 'monthly' })).toEqual({
        salary_max: FIELD_ISSUES.invalid,
      });
    });

    it('enforces x-money-min / x-money-max exactly, to the poisha', () => {
      expect(validate({ ...minimal, price: '100.00' }).success).toBe(true);
      expect(issuesOf({ ...minimal, price: '99.99' })).toEqual({ price: FIELD_ISSUES.outOfRange });
      expect(issuesOf({ ...minimal, price: '10000000.01' })).toEqual({
        price: FIELD_ISSUES.outOfRange,
      });
    });
  });

  describe('numbers', () => {
    it('requires integers where the schema says integer, within bounds', () => {
      expect(issuesOf({ ...minimal, bedrooms: 2.5 })).toEqual({ bedrooms: FIELD_ISSUES.invalid });
      expect(issuesOf({ ...minimal, bedrooms: 21 })).toEqual({ bedrooms: FIELD_ISSUES.outOfRange });
      expect(validate({ ...minimal, floor: -2 }).success).toBe(true);
    });

    it('bounds model years by the current year plus the offset', () => {
      expect(validate({ ...minimal, model_year: 2027 }).success).toBe(true);
      expect(issuesOf({ ...minimal, model_year: 2028 })).toEqual({
        model_year: FIELD_ISSUES.outOfRange,
      });
    });
  });

  it('checks select and multiselect options and duplicates', () => {
    expect(issuesOf({ ...minimal, property_type: 'castle' })).toEqual({
      property_type: FIELD_ISSUES.notAnOption,
    });
    expect(issuesOf({ ...minimal, days: [] })).toEqual({ days: FIELD_ISSUES.required });
    expect(issuesOf({ ...minimal, days: ['sat', 'sat'] })).toEqual({
      days: FIELD_ISSUES.duplicate,
    });
    expect(issuesOf({ ...minimal, days: ['sat', 'mon'] })).toEqual({
      'days.1': FIELD_ISSUES.notAnOption,
    });
  });

  describe('dates', () => {
    it('rejects impossible calendar days', () => {
      expect(issuesOf({ ...minimal, available_from: '2026-02-30' })).toEqual({
        available_from: FIELD_ISSUES.invalid,
      });
    });

    it('rejects a day before today when x-not-before-today is set', () => {
      expect(validate({ ...minimal, available_from: '2026-09-24' }).success).toBe(true);
      expect(issuesOf({ ...minimal, available_from: '2026-09-23' })).toEqual({
        available_from: FIELD_ISSUES.beforeToday,
      });
    });
  });

  describe('text and phone', () => {
    it('trims, rejects blank and over-long text', () => {
      expect(validate({ ...minimal, brand: '  Walton ' }).success).toBe(false);
      expect(validate({ ...minimal, brand: '  Hatil ' })).toEqual({
        success: true,
        data: { ...minimal, brand: 'Hatil' },
      });
      expect(issuesOf({ ...minimal, brand: '   ' })).toEqual({ brand: FIELD_ISSUES.required });
    });

    it('applies pattern, https-only URLs and the BD phone format', () => {
      expect(issuesOf({ ...minimal, eiin: '12345' })).toEqual({ eiin: FIELD_ISSUES.invalid });
      expect(issuesOf({ ...minimal, portfolio_url: 'http://example.com' })).toEqual({
        portfolio_url: FIELD_ISSUES.invalid,
      });
      expect(validate({ ...minimal, portfolio_url: 'https://example.com/work' }).success).toBe(
        true,
      );
      expect(validate({ ...minimal, serial_phone: '+8801711000000' }).success).toBe(true);
      expect(issuesOf({ ...minimal, serial_phone: '01711000000' })).toEqual({
        serial_phone: FIELD_ISSUES.invalid,
      });
    });
  });

  describe('conditional required (allOf)', () => {
    it('requires bedrooms only for the matching property type', () => {
      expect(issuesOf({ ...minimal, property_type: 'flat' })).toEqual({
        bedrooms: FIELD_ISSUES.required,
      });
      expect(validate({ ...minimal, property_type: 'flat', bedrooms: 2 }).success).toBe(true);
    });

    it('requires a field once another is present', () => {
      expect(issuesOf({ ...minimal, salary_max: '9000.00' })).toEqual({
        salary_period: FIELD_ISSUES.required,
      });
    });
  });

  it('compares x-gte-field values, including money as exact poisha', () => {
    expect(issuesOf({ ...minimal, floor: 5, total_floors: 4 })).toEqual({
      total_floors: FIELD_ISSUES.lessThanField,
    });
    expect(validate({ ...minimal, floor: 5, total_floors: 5 }).success).toBe(true);
    expect(issuesOf({ ...minimal, salary_max: '8499.99', salary_period: 'monthly' })).toEqual({
      salary_max: FIELD_ISSUES.lessThanField,
    });
  });
});

describe('validationContextAt', () => {
  it('uses the calendar day in the given timezone, not UTC', () => {
    // 20:30 UTC on 23 Sep is 02:30 on 24 Sep in Dhaka (UTC+6).
    const now = new Date('2026-09-23T20:30:00Z');
    expect(validationContextAt(now, 'Asia/Dhaka')).toEqual({
      today: '2026-09-24',
      currentYear: 2026,
    });
    expect(validationContextAt(new Date('2026-12-31T19:00:00Z'), 'Asia/Dhaka').currentYear).toBe(
      2027,
    );
  });
});

describe('conditional fields (x-show-when)', () => {
  const conditional: FieldSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      property_type: { 'x-field-type': 'select', type: 'string', enum: ['flat', 'shop'] },
      bedrooms: {
        'x-field-type': 'number',
        type: 'integer',
        minimum: 0,
        'x-show-when': { field: 'property_type', in: ['flat'] },
      },
      has_lift: { 'x-field-type': 'bool', type: 'boolean' },
      lift_count: {
        'x-field-type': 'number',
        type: 'integer',
        'x-show-when': { field: 'has_lift', in: [true] },
      },
      // Chained: only for flats (through bedrooms' controller) with a lift.
      notes: {
        'x-field-type': 'textarea',
        type: 'string',
        maxLength: 10,
        'x-show-when': { field: 'property_type', in: ['flat'] },
      },
    },
    required: ['property_type', 'bedrooms', 'notes'],
  };
  const run = (value: unknown) => {
    const result = compileFieldsValidator(conditional, context).safeParse(value);
    return result.success
      ? {}
      : Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]));
  };

  it('requires a conditional required field only while it is visible', () => {
    expect(run({ property_type: 'shop' })).toEqual({});
    expect(run({ property_type: 'flat' })).toEqual({
      bedrooms: FIELD_ISSUES.required,
      notes: FIELD_ISSUES.required,
    });
    expect(run({ property_type: 'flat', bedrooms: 2, notes: 'ok' })).toEqual({});
  });

  it('rejects a value for a hidden field', () => {
    expect(run({ property_type: 'shop', bedrooms: 2 })).toEqual({
      bedrooms: FIELD_ISSUES.notApplicable,
    });
    expect(run({ property_type: 'shop', has_lift: false, lift_count: 1 })).toEqual({
      lift_count: FIELD_ISSUES.notApplicable,
    });
    expect(run({ property_type: 'shop', has_lift: true, lift_count: 1 })).toEqual({});
  });

  it('validates textarea like text, newlines included', () => {
    expect(run({ property_type: 'flat', bedrooms: 1, notes: 'a\nb' })).toEqual({});
    expect(run({ property_type: 'flat', bedrooms: 1, notes: 'x'.repeat(11) })).toEqual({
      notes: FIELD_ISSUES.tooLong,
    });
  });

  it('computes visibility through chains', () => {
    const chained: FieldSchema = {
      ...conditional,
      properties: {
        ...conditional.properties,
        lift_count: {
          'x-field-type': 'select',
          type: 'string',
          enum: ['one', 'two'],
          'x-show-when': { field: 'has_lift', in: [true] },
        },
        lift_brand: {
          'x-field-type': 'text',
          type: 'string',
          maxLength: 20,
          'x-show-when': { field: 'lift_count', in: ['two'] },
        },
      },
    };
    expect([...visibleFields(chained, { has_lift: false, lift_count: 'two' })]).not.toContain(
      'lift_brand',
    );
    expect([...visibleFields(chained, { has_lift: true, lift_count: 'two' })]).toContain(
      'lift_brand',
    );
  });
});

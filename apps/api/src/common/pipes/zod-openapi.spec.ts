import { z } from 'zod';
import { describeZodField } from './zod-openapi';

describe('describeZodField', () => {
  it('describes a required string with format/length checks', () => {
    const field = describeZodField(z.string().email());
    expect(field).toEqual({ schema: { type: 'string', format: 'email' }, required: true });
  });

  it('describes min/max/regex checks on a string', () => {
    const field = describeZodField(z.string().min(4).max(8).regex(/^\d+$/));
    expect(field.schema).toEqual({ type: 'string', minLength: 4, maxLength: 8, pattern: '^\\d+$' });
  });

  it('marks optional and default fields as not required', () => {
    expect(describeZodField(z.string().optional())).toEqual({
      schema: { type: 'string' },
      required: false,
    });
    expect(describeZodField(z.string().default('x'))).toEqual({
      schema: { type: 'string' },
      required: false,
    });
  });

  it('marks nullable fields with schema.nullable', () => {
    expect(describeZodField(z.string().nullable())).toEqual({
      schema: { type: 'string', nullable: true },
      required: true,
    });
  });

  it('describes a coerced number with min/max', () => {
    const field = describeZodField(z.coerce.number().min(-90).max(90));
    expect(field.schema).toEqual({ type: 'number', minimum: -90, maximum: 90 });
  });

  it('marks an int-checked number as integer', () => {
    expect(describeZodField(z.number().int()).schema).toEqual({ type: 'integer' });
  });

  it('describes a boolean', () => {
    expect(describeZodField(z.boolean()).schema).toEqual({ type: 'boolean' });
  });

  it('describes an enum as a string with the allowed values', () => {
    expect(describeZodField(z.enum(['android', 'ios', 'web'])).schema).toEqual({
      type: 'string',
      enum: ['android', 'ios', 'web'],
    });
  });

  it('describes an array by its element schema', () => {
    expect(describeZodField(z.array(z.string().min(1))).schema).toEqual({
      type: 'array',
      items: { type: 'string', minLength: 1 },
    });
  });

  it('describes a nested object, collecting its own required keys', () => {
    const device = z.object({
      platformCode: z.enum(['android', 'ios', 'web']),
      appVersion: z.string().optional(),
    });
    expect(describeZodField(device).schema).toEqual({
      type: 'object',
      properties: {
        platformCode: { type: 'string', enum: ['android', 'ios', 'web'] },
        appVersion: { type: 'string' },
      },
      required: ['platformCode'],
    });
  });

  it('describes the wrapped input shape of a transform, not its output', () => {
    const phone = z.string().transform((value) => value.toUpperCase());
    expect(describeZodField(phone)).toEqual({ schema: { type: 'string' }, required: true });
  });

  it('describes a literal as a single-value enum', () => {
    expect(describeZodField(z.literal('*')).schema).toEqual({ type: 'string', enum: ['*'] });
  });

  it('describes a union as oneOf its members', () => {
    const moduleName = z.union([z.literal('*'), z.string().regex(/^[a-z]+$/)]);
    expect(describeZodField(moduleName).schema).toEqual({
      oneOf: [
        { type: 'string', enum: ['*'] },
        { type: 'string', pattern: '^[a-z]+$' },
      ],
    });
  });

  it('describes a discriminated union as oneOf its member objects', () => {
    const { schema } = describeZodField(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), n: z.number() }),
        z.object({ kind: z.literal('b') }),
      ]),
    );
    expect(schema.oneOf).toEqual([
      {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['a'] }, n: { type: 'number' } },
        required: ['kind', 'n'],
      },
      { type: 'object', properties: { kind: { type: 'string', enum: ['b'] } }, required: ['kind'] },
    ]);
  });

  it('describes a record as an object with typed additional properties', () => {
    expect(describeZodField(z.record(z.boolean())).schema).toEqual({
      type: 'object',
      additionalProperties: { type: 'boolean' },
    });
  });
});

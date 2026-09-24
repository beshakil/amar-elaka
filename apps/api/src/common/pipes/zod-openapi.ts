import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import {
  ZodArray,
  ZodBoolean,
  ZodDefault,
  ZodEffects,
  ZodEnum,
  ZodLiteral,
  ZodNullable,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodRawShape,
  ZodRecord,
  ZodString,
  ZodUnion,
  type ZodTypeAny,
} from 'zod';

type ZodObjectAny = ZodObject<ZodRawShape>;
type ZodArrayAny = ZodArray<ZodTypeAny>;
type ZodEnumAny = ZodEnum<[string, ...string[]]>;
type ZodOptionalAny = ZodOptional<ZodTypeAny>;
type ZodNullableAny = ZodNullable<ZodTypeAny>;
type ZodDefaultAny = ZodDefault<ZodTypeAny>;
type ZodEffectsAny = ZodEffects<ZodTypeAny>;

interface UnwrapResult {
  schema: ZodTypeAny;
  required: boolean;
  nullable: boolean;
}

/**
 * Peels off the wrappers that don't affect the wire shape: optional/default
 * (not required), nullable (tracked separately), and effects (transform,
 * e.g. `phoneSchema`'s normalization) — the client still sends the *input*
 * shape, so we describe the wrapped schema, not the transform's output.
 */
function unwrap(schema: ZodTypeAny): UnwrapResult {
  let required = true;
  let nullable = false;
  let current = schema;
  for (;;) {
    if (current instanceof ZodOptional) {
      required = false;
      current = (current as ZodOptionalAny).unwrap();
      continue;
    }
    if (current instanceof ZodDefault) {
      required = false;
      current = (current as ZodDefaultAny).removeDefault();
      continue;
    }
    if (current instanceof ZodNullable) {
      nullable = true;
      current = (current as ZodNullableAny).unwrap();
      continue;
    }
    if (current instanceof ZodEffects) {
      current = (current as ZodEffectsAny).innerType();
      continue;
    }
    break;
  }
  return { schema: current, required, nullable };
}

export interface FieldDescriptor {
  schema: SchemaObject;
  required: boolean;
}

/** Converts one zod schema (a DTO field, or an array element) into an OpenAPI fragment. */
export function describeZodField(schema: ZodTypeAny): FieldDescriptor {
  const { schema: inner, required, nullable } = unwrap(schema);
  const out = buildSchema(inner);
  if (nullable) out.nullable = true;
  return { schema: out, required };
}

function buildSchema(schema: ZodTypeAny): SchemaObject {
  if (schema instanceof ZodString) {
    const out: SchemaObject = { type: 'string' };
    for (const check of schema._def.checks) {
      if (check.kind === 'email') out.format = 'email';
      else if (check.kind === 'min') out.minLength = check.value;
      else if (check.kind === 'max') out.maxLength = check.value;
      else if (check.kind === 'regex') out.pattern = check.regex.source;
    }
    return out;
  }
  if (schema instanceof ZodNumber) {
    const out: SchemaObject = { type: schema.isInt ? 'integer' : 'number' };
    if (schema.minValue !== null) out.minimum = schema.minValue;
    if (schema.maxValue !== null) out.maximum = schema.maxValue;
    return out;
  }
  if (schema instanceof ZodBoolean) return { type: 'boolean' };
  if (schema instanceof ZodEnum)
    return { type: 'string', enum: [...(schema as ZodEnumAny).options] };
  if (schema instanceof ZodArray) {
    return { type: 'array', items: describeZodField((schema as ZodArrayAny).element).schema };
  }
  if (schema instanceof ZodLiteral) {
    const value: unknown = (schema as ZodLiteral<unknown>).value;
    if (typeof value === 'string') return { type: 'string', enum: [value] };
    if (typeof value === 'number') return { type: 'number', enum: [value] };
    if (typeof value === 'boolean') return { type: 'boolean', enum: [value] };
    return {};
  }
  if (schema instanceof ZodUnion) {
    const options = (schema as ZodUnion<[ZodTypeAny, ...ZodTypeAny[]]>).options;
    return { oneOf: options.map((option) => describeZodField(option).schema) };
  }
  if (schema instanceof ZodRecord) {
    const values = (schema as ZodRecord).valueSchema;
    return { type: 'object', additionalProperties: describeZodField(values).schema };
  }
  if (schema instanceof ZodObject) {
    const properties: Record<string, SchemaObject> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries((schema as ZodObjectAny).shape)) {
      const field = describeZodField(value);
      properties[key] = field.schema;
      if (field.required) required.push(key);
    }
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
  }
  // Not explicitly modeled (z.any(), z.unknown(), ...) — still a
  // valid OpenAPI fragment, just untyped. Extend here as new zod features
  // show up in DTOs.
  return {};
}

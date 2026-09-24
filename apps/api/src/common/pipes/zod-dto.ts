import { ApiProperty, type ApiPropertyOptions } from '@nestjs/swagger';
import {
  ZodEffects,
  ZodObject,
  type ZodRawShape,
  type ZodSchema,
  type ZodTypeAny,
  type z,
} from 'zod';
import { describeZodField } from './zod-openapi';

type ZodObjectAny = ZodObject<ZodRawShape>;

/**
 * A `.refine()`d object is a ZodEffects around the object; the wire shape is
 * still the inner object's, so that is what gets documented.
 */
function documentedShape(schema: ZodSchema): ZodObjectAny | undefined {
  let current: ZodTypeAny = schema;
  while (current instanceof ZodEffects) current = (current as ZodEffects<ZodTypeAny>).innerType();
  return current instanceof ZodObject ? (current as ZodObjectAny) : undefined;
}

export interface ZodDtoClass<T extends ZodSchema = ZodSchema> {
  new (): z.infer<T>;
  readonly schema: T;
}

/**
 * Builds a class that carries its zod schema as a static so
 * `ZodValidationPipe` can find it via `ArgumentMetadata.metatype` — the
 * same trick `nestjs-zod` uses, without the extra dependency.
 *
 * It also applies `@ApiProperty` to the class for each top-level shape key,
 * derived from the same zod schema, so `SwaggerModule` describes the real
 * request shape (used for both `@Body()` and `@Query()` DTOs) instead of an
 * empty object — the zod schema stays the single source of truth for both
 * validation and docs.
 *
 * Usage: `class CreateThingDto extends createZodDto(createThingSchema) {}`
 * then `@Body() body: CreateThingDto` in a controller.
 */
export function createZodDto<T extends ZodSchema>(schema: T): ZodDtoClass<T> {
  class ZodDto {
    static readonly schema = schema;
  }

  const shape = documentedShape(schema);
  if (shape) {
    for (const [key, value] of Object.entries(shape.shape)) {
      const field = describeZodField(value);
      const options: ApiPropertyOptions =
        field.schema.type === 'object'
          ? ({ ...field.schema, selfRequired: field.required } as ApiPropertyOptions)
          : ({ ...field.schema, required: field.required } as ApiPropertyOptions);
      ApiProperty(options)(ZodDto.prototype, key);
    }
  }

  return ZodDto;
}

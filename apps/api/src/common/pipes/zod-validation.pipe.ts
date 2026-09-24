import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ValidationException } from '../exceptions/validation.exception';
import type { ZodDtoClass } from './zod-dto';

function hasZodSchema(metatype: unknown): metatype is ZodDtoClass {
  return typeof metatype === 'function' && 'schema' in metatype;
}

/**
 * Global validation pipe. Only acts on parameters whose type was built with
 * `createZodDto` — everything else (primitives, plain objects with no
 * attached schema) passes through unchanged.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (!hasZodSchema(metadata.metatype)) {
      return value;
    }

    const result = metadata.metatype.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationException(result.error);
    }
    return result.data;
  }
}

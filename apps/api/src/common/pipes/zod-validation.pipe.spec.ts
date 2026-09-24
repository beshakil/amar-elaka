import { z } from 'zod';
import { ValidationException } from '../exceptions/validation.exception';
import { createZodDto } from './zod-dto';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe();
  class CreateThingDto extends createZodDto(z.object({ name: z.string().min(1) })) {}

  it('passes through values whose metatype has no attached schema', () => {
    const value = { anything: true };
    expect(pipe.transform(value, { type: 'body', metatype: Object })).toBe(value);
  });

  it('returns the parsed value when validation succeeds', () => {
    const result = pipe.transform({ name: 'shop' }, { type: 'body', metatype: CreateThingDto });
    expect(result).toEqual({ name: 'shop' });
  });

  it('throws ValidationException when validation fails', () => {
    expect(() => pipe.transform({ name: '' }, { type: 'body', metatype: CreateThingDto })).toThrow(
      ValidationException,
    );
  });
});

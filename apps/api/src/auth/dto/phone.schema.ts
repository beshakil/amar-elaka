import { z } from 'zod';
import { normalizeBdPhone } from '../phone/phone-normalizer';

/** Accepts 01XXXXXXXXX / 8801XXXXXXXXX / +8801XXXXXXXXX and normalizes to E.164. */
export const phoneSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeBdPhone(value);
  if (!normalized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Enter a valid Bangladeshi mobile number.',
    });
    return z.NEVER;
  }
  return normalized;
});

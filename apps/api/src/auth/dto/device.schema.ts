import { z } from 'zod';

/**
 * An optional device detail: a string, or absent. A null counts as absent:
 * the app once sent its unknown fields as null, and that failed every phone
 * login with VALIDATION_FAILED (found on a real device).
 */
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);

/** Mirrors device_platforms (android/ios/web) — user_devices.platform_code, §2.9. */
export const deviceSchema = z.object({
  platformCode: z.enum(['android', 'ios', 'web']),
  appVersion: optionalText,
  deviceModel: optionalText,
  fingerprintHash: optionalText,
  pushToken: optionalText,
});

export type DeviceInput = z.infer<typeof deviceSchema>;

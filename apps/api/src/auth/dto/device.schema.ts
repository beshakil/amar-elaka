import { z } from 'zod';

/** Mirrors device_platforms (android/ios/web) — user_devices.platform_code, §2.9. */
export const deviceSchema = z.object({
  platformCode: z.enum(['android', 'ios', 'web']),
  appVersion: z.string().optional(),
  deviceModel: z.string().optional(),
  fingerprintHash: z.string().optional(),
  pushToken: z.string().optional(),
});

export type DeviceInput = z.infer<typeof deviceSchema>;

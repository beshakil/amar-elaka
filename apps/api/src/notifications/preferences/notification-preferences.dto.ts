import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

const channel = z.enum(['in_app', 'push', 'sms', 'email']);
// settings-exempt: a request-size guard on an opaque token (FCM tokens are ~160–250 chars)
const MAX_TOKEN_LENGTH = 4096;

export const preferenceViewSchema = z.object({
  type: z.string(),
  /** Security and account notices: they come even in quiet hours and past caps. */
  urgent: z.boolean(),
  channels: z.array(
    z.object({
      channel,
      enabled: z.boolean(),
      /** The user can't switch this one (the inbox, or a type that must reach them). */
      locked: z.boolean(),
    }),
  ),
});
export const preferencesSchema = z.object({ items: z.array(preferenceViewSchema) });
export type Preferences = z.infer<typeof preferencesSchema>;
export class PreferencesDto extends createZodDto(preferencesSchema) {}

export const updatePreferencesSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            type: z.string().min(1),
            channel: z.enum(['push', 'sms', 'email']),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type UpdatePreferences = z.infer<typeof updatePreferencesSchema>;
export class UpdatePreferencesDto extends createZodDto(updatePreferencesSchema) {}

export const pushTokenSchema = z
  .object({
    platform: z.enum(['android', 'ios', 'web']),
    /** The FCM registration token (web too: Firebase Messaging, ADR 059). */
    token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  })
  .strict();
export type PushTokenInput = z.infer<typeof pushTokenSchema>;
export class PushTokenDto extends createZodDto(pushTokenSchema) {}

export const forgetPushTokenSchema = z
  .object({ token: z.string().min(1).max(MAX_TOKEN_LENGTH) })
  .strict();
export class ForgetPushTokenDto extends createZodDto(forgetPushTokenSchema) {}

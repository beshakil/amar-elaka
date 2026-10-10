'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { apiFetch } from '../api/fetch';
import { ApiError, ApiShapeError, ApiUnreachableError } from '../api/errors';
import {
  notificationInboxSchema,
  notificationPreferencesSchema,
  unreadCountSchema,
  type NotificationInbox,
  type NotificationPreferences,
} from '../api/schemas';
import { readSession } from '../auth/session';
import { currentTenantId } from '../tenant';

/**
 * The bell's, the notification page's and the settings page's actions (ADR
 * 059/060): the same endpoints as the app, with the member's session.
 */

export type NotificationResult<T> = { ok: true; data: T } | { ok: false; code: string };

const uuid = z.string().uuid();
const preferenceSchema = z
  .object({
    type: z.string().regex(/^[a-z_]{1,64}$/),
    channel: z.enum(['push', 'sms', 'email']),
    enabled: z.boolean(),
  })
  .strict();
// An FCM registration token: opaque, URL-safe characters and ':'.
const pushTokenSchema = z.string().regex(/^[A-Za-z0-9_:\-.]{20,4096}$/);

async function asMember<T>(
  call: (auth: { tenantId: string; accessToken: string }) => Promise<T>,
): Promise<NotificationResult<T>> {
  const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
  if (!session) return { ok: false, code: 'UNAUTHENTICATED' };
  if (!tenantId) return { ok: false, code: 'TENANT_REQUIRED' };
  try {
    return { ok: true, data: await call({ tenantId, accessToken: session.accessToken }) };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, code: error.code };
    if (error instanceof ApiUnreachableError) return { ok: false, code: 'NETWORK' };
    if (error instanceof ApiShapeError) return { ok: false, code: 'UNEXPECTED_RESPONSE' };
    throw error;
  }
}

const invalid = { ok: false, code: 'VALIDATION_FAILED' } as const;

/** The bell's dropdown: the newest few, and how many are unread. */
export async function recentNotifications(): Promise<NotificationResult<NotificationInbox>> {
  return asMember((auth) =>
    apiFetch({
      path: '/notifications',
      schema: notificationInboxSchema,
      // The dropdown's length: presentation, not a business rule.
      query: { limit: '8' },
      ...auth,
    }),
  );
}

export async function unreadNotifications(): Promise<NotificationResult<number>> {
  return asMember(async (auth) => {
    const answer = await apiFetch({
      path: '/notifications/unread-count',
      schema: unreadCountSchema,
      ...auth,
    });
    return answer.unreadCount;
  });
}

export async function markNotificationRead(id: string): Promise<NotificationResult<null>> {
  if (!uuid.safeParse(id).success) return invalid;
  return asMember(async (auth) => {
    await apiFetch({
      path: `/notifications/${id}/read`,
      method: 'POST',
      schema: z.null(),
      ...auth,
    });
    return null;
  });
}

/** "সব পড়া হয়েছে" (a form button on the notification page). */
export async function markAllNotificationsRead(): Promise<void> {
  await asMember((auth) =>
    apiFetch({
      path: '/notifications/read-all',
      method: 'POST',
      schema: unreadCountSchema,
      ...auth,
    }),
  );
  revalidatePath('/notifications');
}

export async function setNotificationPreference(
  input: unknown,
): Promise<NotificationResult<NotificationPreferences>> {
  const body = preferenceSchema.safeParse(input);
  if (!body.success) return invalid;
  return asMember((auth) =>
    apiFetch({
      path: '/me/notification-preferences',
      method: 'PUT',
      schema: notificationPreferencesSchema,
      body: { items: [body.data] },
      ...auth,
    }),
  );
}

/** This browser's FCM token (Web Push opt-in), registered as a `web` device. */
export async function registerWebPushToken(token: string): Promise<NotificationResult<null>> {
  if (!pushTokenSchema.safeParse(token).success) return invalid;
  return asMember(async (auth) => {
    await apiFetch({
      path: '/me/devices/push-token',
      method: 'PUT',
      schema: z.null(),
      body: { platform: 'web', token },
      ...auth,
    });
    return null;
  });
}

export async function forgetWebPushToken(token: string): Promise<NotificationResult<null>> {
  if (!pushTokenSchema.safeParse(token).success) return invalid;
  return asMember(async (auth) => {
    await apiFetch({
      path: '/me/devices/push-token',
      method: 'DELETE',
      schema: z.null(),
      body: { token },
      ...auth,
    });
    return null;
  });
}

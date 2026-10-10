import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

export const inboxQuerySchema = z
  .object({
    /** The `nextCursor` of the previous page. */
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export class InboxQueryDto extends createZodDto(inboxQuerySchema) {}

export const notificationIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export class NotificationIdParamDto extends createZodDto(notificationIdParamSchema) {}

/**
 * One notification. `title` and `body` are rendered on the server from
 * notification_templates in the user's locale (ADR 059); `type` + `params`
 * stay for clients that lay a notification out themselves.
 */
export const inboxItemSchema = z.object({
  id: z.string().uuid(),
  /** notification_types code, e.g. post_approved, place_edit_rejected. */
  type: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  /** Events folded into this one ("৪টি নতুন মেসেজ" = 4); 1 for a single event. */
  count: z.number().int(),
  params: z.record(z.string().nullable()),
  /** In-app route, e.g. /posts/<id>; null when there is nothing to open. */
  deepLink: z.string().nullable(),
  entityId: z.string().uuid().nullable(),
  read: z.boolean(),
  createdAt: z.string().datetime(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

export const inboxPageSchema = z.object({
  items: z.array(inboxItemSchema),
  nextCursor: z.string().uuid().nullable(),
  /** The badge: unread, not archived, not expired. */
  unreadCount: z.number().int(),
});
export type InboxPage = z.infer<typeof inboxPageSchema>;
export class InboxPageDto extends createZodDto(inboxPageSchema) {}

export const unreadCountSchema = z.object({ unreadCount: z.number().int() });
export type UnreadCount = z.infer<typeof unreadCountSchema>;
export class UnreadCountDto extends createZodDto(unreadCountSchema) {}

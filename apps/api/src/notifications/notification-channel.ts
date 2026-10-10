/**
 * The notification types the code sends (lookup `notification_types`, with
 * its delivery behaviour since 0055). Each needs an active Bengali in_app
 * template (notifications.db-spec.ts checks).
 */
export const NOTIFICATION_TYPES = [
  'post_approved',
  'post_rejected',
  'post_removed',
  'post_expiring',
  'saved_search_match',
  'saved_search_paused',
  'saved_search_weekly_digest',
  'saved_post_price_drop',
  'geo_budget_warning',
  'geo_budget_exhausted',
  'place_approved',
  'place_rejected',
  'place_claim_approved',
  'place_claim_rejected',
  'place_edit_approved',
  'place_edit_rejected',
  'store_staff_invited',
  'store_suspended',
  'store_reinstated',
  'store_import_finished',
  'new_message',
  'ban_issued',
  'appeal_decided',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** notification_channels (0009). */
export const CHANNELS = ['in_app', 'push', 'sms', 'email'] as const;
export type ChannelCode = (typeof CHANNELS)[number];
/** The channels that interrupt (and cost): everything but the inbox. */
export type InterruptChannel = Exclude<ChannelCode, 'in_app'>;

/** What a sender asks for: NotificationService.send() queues it, the worker does the rest. */
export interface OutgoingNotification {
  userId: string;
  type: NotificationType;
  /** Where it happened (quiet hours use its timezone, an SMS bills it); null = the platform. */
  tenantId?: string | null;
  /**
   * Template variables. Texts are rendered from notification_templates in
   * the user's locale (no user-facing text in code); clients also get them
   * as data. A `reasonCode` is named in words from moderation_reasons.
   */
  params: Record<string, string | null>;
  /** In-app route to open, e.g. /posts/<id>. */
  deepLink: string | null;
  /** The entity the notification is about (a post, place, claim, conversation…). */
  entityId: string | null;
  /** Same key twice = one notification (e.g. a retried moderation action). */
  dedupeKey: string | null;
  /**
   * For a collapsible type: events with the same key inside the collapse
   * window become one notification ("৪টি নতুন মেসেজ"), opening `deepLink`.
   * Default: the type itself, opening the sender's deep link.
   */
  collapse?: { key: string; deepLink: string | null };
}

/** One send on one interrupting channel, rendered for its recipient. */
export interface ChannelMessage {
  deliveryId: string;
  notificationId: string;
  userId: string;
  tenantId: string | null;
  type: NotificationType;
  title: string | null;
  body: string;
  deepLink: string | null;
  /** Data for the client (all strings: FCM requires it). */
  data: Record<string, string>;
  /** Pushes with the same key replace each other on the device. */
  collapseKey: string | null;
  urgent: boolean;
}

/**
 * How a send ended:
 *  - sent: it left (sms carries its segments);
 *  - undeliverable: nobody to send to (no device, every token invalid) — no retry.
 * A transient failure throws: the queue retries the delivery job.
 */
export type ChannelOutcome =
  | { status: 'sent'; recipient: string; providerMessageId: string | null; smsSegments?: number }
  | { status: 'undeliverable'; recipient: string; reason: string };

/**
 * One way of reaching a user (push, SMS, email), registered under
 * NOTIFICATION_CHANNELS. The in-app inbox is the notification row itself
 * (InAppNotificationChannel), written before any of these run. Senders never
 * see channels: they call NotificationService.send() and the worker
 * (NotificationDispatcher) decides which channels a notification takes.
 */
export interface NotificationChannel {
  readonly name: InterruptChannel;
  deliver(message: ChannelMessage): Promise<ChannelOutcome>;
}

export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

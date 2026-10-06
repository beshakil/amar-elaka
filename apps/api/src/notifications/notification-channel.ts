/** A notification type code (lookup `notification_types`). */
export type NotificationType =
  | 'post_approved'
  | 'post_rejected'
  | 'post_removed'
  | 'post_expiring'
  | 'saved_search_match'
  | 'saved_search_paused'
  | 'geo_budget_warning'
  | 'geo_budget_exhausted'
  | 'place_approved'
  | 'place_rejected'
  | 'place_claim_approved'
  | 'place_claim_rejected';

export interface OutgoingNotification {
  userId: string;
  type: NotificationType;
  /** Template parameters; texts are rendered per locale by the clients from the type + params. */
  params: Record<string, string | null>;
  /** In-app route to open, e.g. /posts/<id>. */
  deepLink: string | null;
  /** The entity the notification is about (a post, place or place claim id). */
  entityId: string | null;
  /** Same key twice = one notification (e.g. a retried moderation action). */
  dedupeKey: string | null;
}

/**
 * One way of reaching a user. In-app ships now (notifications table); push
 * (FCM) arrives in week 11 as another implementation, registered under
 * NOTIFICATION_CHANNELS — nothing that sends notifications changes.
 */
export interface NotificationChannel {
  readonly name: string;
  deliver(notification: OutgoingNotification): Promise<void>;
}

export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

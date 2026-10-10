import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.client';
import type { OutgoingNotification } from './notification-channel';
import { NotificationsRepository } from './notifications.repository';
import type { Locale } from './templates/template-renderer';
import { NotificationTexts } from './templates/notification-texts';

export interface InboxRecord {
  notificationId: string;
  /** How many events the row now holds (1, or more after a collapse). */
  count: number;
  /** A collapse into an existing unread row (no new row). */
  collapsed: boolean;
}

/**
 * The in-app channel: the inbox row in `notifications`, which every other
 * channel's delivery points at. Written first, in the dispatcher's
 * transaction (system role — only it may insert or collapse, RLS 0009/0055):
 *
 *  - a dedupe key already used: nothing (undefined) — the event was sent;
 *  - a collapsible type with an unread row of the same key inside the
 *    window: that row takes the event (count + 1, latest params, the
 *    "collapsed" template: "৪টি নতুন মেসেজ"); it keeps its place in the
 *    inbox (paged by id) — the push and the unread badge carry the news;
 *  - otherwise a new row, its title and body rendered in the user's locale.
 */
@Injectable()
export class InAppNotificationChannel {
  readonly name = 'in_app';

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly texts: NotificationTexts,
  ) {}

  async record(
    tx: DatabaseTransaction,
    n: OutgoingNotification,
    options: { locale: Locale; collapseKey: string | null; collapseSince: Date | null; at: Date },
  ): Promise<InboxRecord | undefined> {
    if (options.collapseKey !== null && options.collapseSince !== null) {
      const existing = await this.repo.findCollapsible(
        tx,
        n.userId,
        n.type,
        options.collapseKey,
        options.collapseSince,
      );
      if (existing) {
        const count = existing.collapse_count + 1;
        const text = await this.texts.render(tx, {
          type: n.type,
          channel: 'in_app',
          locale: options.locale,
          params: n.params,
          count,
        });
        await this.repo.collapseInto(tx, existing.id, {
          count,
          params: n.params,
          deepLink: n.collapse?.deepLink ?? n.deepLink,
          entityId: n.entityId,
          title: text?.title ?? null,
          body: text?.body ?? null,
          at: options.at,
        });
        return { notificationId: existing.id, count, collapsed: true };
      }
    }
    const text = await this.texts.render(tx, {
      type: n.type,
      channel: 'in_app',
      locale: options.locale,
      params: n.params,
      count: 1,
    });
    const id = await this.repo.insertNotification(tx, {
      userId: n.userId,
      tenantId: n.tenantId ?? null,
      type: n.type,
      params: n.params,
      deepLink: n.deepLink,
      entityId: n.entityId,
      dedupeKey: n.dedupeKey,
      collapseKey: options.collapseKey,
      title: text?.title ?? null,
      body: text?.body ?? null,
      at: options.at,
    });
    return id ? { notificationId: id, count: 1, collapsed: false } : undefined;
  }
}

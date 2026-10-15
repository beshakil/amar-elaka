import { Injectable, Logger } from '@nestjs/common';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { NotificationType } from '../notifications/notification-channel';
import { NotificationService } from '../notifications/notification.service';
import { BansRepository } from './bans.repository';

/** Where each notice opens in the apps (mobile deep links, web routes). */
export const BAN_DEEP_LINKS = {
  account: '/account/bans',
  appealsArea: '/moderation/appeals',
  appealsPlatform: '/platform/appeals',
  blacklist: '/platform/blacklist',
  complaints: '/moderation/complaints',
  myComplaints: '/complaints',
} as const;

/**
 * Notices for bans, appeals and complaints. A notice never fails the
 * decision it reports: the decision is committed first; a queueing failure is
 * logged. Staff recipients (an area's admins, the platform admins) are read
 * as the system.
 */
@Injectable()
export class BanNotifier {
  private readonly logger = new Logger(BanNotifier.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: BansRepository,
  ) {}

  async toUser(
    userId: string | null,
    type: NotificationType,
    tenantId: string | null,
    params: Record<string, string | null>,
    deepLink: string | null,
    entityId: string,
    dedupeKey: string,
  ): Promise<void> {
    if (!userId) return;
    try {
      await this.notifications.send({
        userId,
        type,
        tenantId,
        params,
        deepLink,
        entityId,
        dedupeKey,
      });
    } catch (error) {
      this.logger.warn(`could not queue ${type} for ${entityId}: ${String(error)}`);
    }
  }

  async toStaff(
    kind: 'area_admins' | 'platform_admins',
    tenantId: string | null,
    type: NotificationType,
    params: Record<string, string | null>,
    deepLink: string,
    entityId: string,
    dedupeKey: string,
  ): Promise<void> {
    let recipients: string[] = [];
    try {
      recipients = await this.context.run({ role: 'system' }, () =>
        this.tenantDb.transaction((tx) => this.repo.recipients(tx, kind, tenantId), {
          accessMode: 'read only',
        }),
      );
    } catch (error) {
      this.logger.warn(`could not read ${kind} for ${entityId}: ${String(error)}`);
    }
    for (const userId of recipients) {
      await this.toUser(
        userId,
        type,
        kind === 'platform_admins' ? null : tenantId,
        params,
        deepLink,
        entityId,
        `${dedupeKey}:${userId}`,
      );
    }
  }
}

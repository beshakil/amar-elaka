import { HttpStatus, Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../../auth/exceptions/auth.exceptions';
import { DomainException } from '../../common/exceptions/domain-exception';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { SettingsService } from '../../settings/settings.service';
import type { InboxPage, InboxQuery, UnreadCount } from './inbox.dto';
import { InboxRepository, type InboxRow } from './inbox.repository';

export class NotificationNotFoundException extends DomainException {
  readonly code = 'NOTIFICATION_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This notification does not exist.');
  }
}

/**
 * The signed-in user's in-app inbox (the in_app channel's rows). User-level:
 * the same inbox whatever tenant the request is in.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: InboxRepository,
    private readonly settings: SettingsService,
  ) {}

  async page(query: InboxQuery): Promise<InboxPage> {
    this.requireUser();
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('notifications_page_size_default'),
      this.settings.get('notifications_page_size_max'),
    ]);
    const limit = Math.min(query.limit ?? pageDefault, pageMax);
    const { rows, unread } = await this.tenantDb.transaction(
      async (tx) => ({
        rows: await this.repo.page(tx, query.cursor ?? null, limit + 1),
        unread: await this.repo.unreadCount(tx),
      }),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map(toItem),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      unreadCount: unread,
    };
  }

  async unreadCount(): Promise<UnreadCount> {
    this.requireUser();
    const unreadCount = await this.tenantDb.transaction((tx) => this.repo.unreadCount(tx), {
      accessMode: 'read only',
    });
    return { unreadCount };
  }

  async markRead(id: string): Promise<void> {
    this.requireUser();
    const found = await this.tenantDb.transaction((tx) => this.repo.markRead(tx, id));
    if (!found) throw new NotificationNotFoundException();
  }

  async markAllRead(): Promise<UnreadCount> {
    this.requireUser();
    await this.tenantDb.transaction((tx) => this.repo.markAllRead(tx));
    return { unreadCount: 0 };
  }

  private requireUser(): string {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }
}

function toItem(row: InboxRow): InboxPage['items'][number] {
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(row.params)) {
    params[key] =
      value === null || value === undefined
        ? null
        : typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : JSON.stringify(value);
  }
  return {
    id: row.id,
    type: row.type_code,
    title: row.title,
    body: row.body,
    count: row.collapse_count,
    params,
    deepLink: row.deep_link,
    entityId: row.entity_id,
    read: row.read_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

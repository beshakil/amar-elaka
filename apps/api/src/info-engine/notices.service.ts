import { Injectable } from '@nestjs/common';
import { PostOwnershipService } from '../posts/post-ownership.service';
import type {
  Created,
  InfoList,
  NoticeDetail,
  NoticeInput,
  NoticeListQuery,
  ReportInput,
} from './dto/info-engine.dto';
import { noticeCard } from './info-cards';
import {
  InfoItemNotFoundException,
  NoticeRefusedException,
  mapInfoEngineErrors,
} from './info-engine.exceptions';
import { InfoEngineRepository } from './info-engine.repository';
import { InfoMedia } from './info-media';
import { InfoScope } from './info-scope';

/**
 * Notices (ADR 065) on one table: the area's local notices (union /
 * pourashava, school, mosque committee…), community notices including
 * janaza and condolence (members post, moderators approve, the respectful
 * wording is the apps'), and the partner's advisories (weather). Each has a
 * validity window and expires on its own (notice_*_expiry_days). PDF or
 * image attachments.
 */
@Injectable()
export class NoticesService {
  constructor(
    private readonly scope: InfoScope,
    private readonly repo: InfoEngineRepository,
    private readonly media: InfoMedia,
    private readonly ownership: PostOwnershipService,
  ) {}

  async list(query: NoticeListQuery): Promise<InfoList> {
    const tenantId = this.scope.tenantId();
    const { radiusKm, limit } = await this.scope.listing(tenantId);
    const rows = await this.scope.read(async (tx) =>
      this.repo.noticesNear(
        tx,
        await this.scope.origin(tx, tenantId, query),
        radiusKm,
        query.category ?? null,
        limit,
      ),
    );
    return { items: rows.map(noticeCard), radiusKm, next: null };
  }

  async detail(id: string): Promise<NoticeDetail> {
    this.scope.tenantId();
    const owner = await this.scope.asSystem((tx) => this.repo.ownerTenant(tx, 'notices', id));
    if (!owner) throw new InfoItemNotFoundException();
    const row = await this.ownership.inTenant(owner, 'lookup', () =>
      this.scope.read((tx) => this.repo.notice(tx, id)),
    );
    if (!row) throw new InfoItemNotFoundException();
    const attachments = await this.media.resolve(
      await this.scope.asSystem((tx) => this.repo.attachments(tx, 'notice_id', id)),
    );
    return {
      card: noticeCard({ ...row, attachments: attachments.length }),
      type: row.notice_type_code,
      category: row.category_code,
      body: row.body,
      issuerName: row.issuer_name,
      isOfficial: row.is_official,
      isPinned: row.is_pinned,
      template: row.template_code,
      templateFields: row.template_fields,
      validFrom: row.valid_from?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      publishedAt: row.published_at?.toISOString() ?? null,
      areaName: row.area_bn,
      attachments,
    };
  }

  /**
   * A member posts a community notice (it waits for a moderator); the area's
   * staff and field agents post any type, published at once. Attachments are
   * the caller's own uploads (POST /media/presign, kind image or document).
   */
  async create(input: NoticeInput): Promise<Created> {
    const tenantId = this.scope.tenantId();
    const max = await this.scope.settings.get('notice_attachments_max');
    if (input.attachmentIds.length > max) throw new NoticeRefusedException('attachments');
    if (input.template && !['obituary', 'community_event'].includes(input.type)) {
      throw new NoticeRefusedException('template');
    }
    return this.ownership.inTenant(tenantId, 'ensure', () =>
      mapInfoEngineErrors(() =>
        this.scope.write(async (tx) => {
          const created = await this.repo.insertNotice(tx, input, this.scope.isStaff());
          if (created.status === 'published') await this.repo.defaultNoticeExpiry(tx, created.id);
          await this.repo.attach(tx, 'notice_id', created.id, input.attachmentIds);
          return created;
        }),
      ),
    );
  }

  async report(id: string, input: ReportInput): Promise<void> {
    this.scope.tenantId();
    const owner = await this.scope.asSystem((tx) => this.repo.ownerTenant(tx, 'notices', id));
    if (!owner) throw new InfoItemNotFoundException();
    await this.ownership.inTenant(owner, 'ensure', () =>
      this.scope.write((tx) =>
        this.repo.report(tx, 'notice_id', id, input.reasonCode, input.details ?? null),
      ),
    );
  }
}

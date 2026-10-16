import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { contactHref, LEAD_CHANNEL } from '../engagement/contact-payload';
import type { ContactChannel, ContactReveal } from '../engagement/dto/engagement.dto';
import { LeadGate } from '../engagement/lead-gate';
import { viewerKey, type ViewerSignals } from '../engagement/viewer-key';
import { PostOwnershipService } from '../posts/post-ownership.service';
import type {
  Created,
  InfoList,
  LostFoundDetail,
  LostFoundInput,
  LostFoundListQuery,
  ReportInput,
} from './dto/info-engine.dto';
import { lostFoundCard } from './info-cards';
import {
  InfoItemNotFoundException,
  LostFoundRefusedException,
  mapInfoEngineErrors,
} from './info-engine.exceptions';
import { InfoEngineRepository } from './info-engine.repository';
import { InfoMedia } from './info-media';
import { InfoNotifier } from './info-notifier';
import { InfoScope } from './info-scope';
import { lostFoundMessage } from './info-message.templates';

/**
 * Lost & found (ADR 065): people, pets and items, with a photo and where and
 * when last seen, near the viewer from every area. Every member report waits
 * for a moderator (this attracts abuse); a later edit goes back to review.
 * The reporter's number leaves only through the tracked contact (a lead,
 * LeadGate) — and the reporter is told someone got in touch. Open reports archive after lost_found_expiry_days.
 */
@Injectable()
export class LostFoundService {
  private readonly secret: string;

  constructor(
    private readonly scope: InfoScope,
    private readonly repo: InfoEngineRepository,
    private readonly media: InfoMedia,
    private readonly ownership: PostOwnershipService,
    private readonly leads: LeadGate,
    private readonly notifier: InfoNotifier,
    @Inject(APP_CONFIG) env: Pick<Env, 'JWT_SECRET'>,
  ) {
    this.secret = env.JWT_SECRET;
  }

  async list(query: LostFoundListQuery): Promise<InfoList> {
    const tenantId = this.scope.tenantId();
    const { radiusKm, limit } = await this.scope.listing(tenantId);
    const rows = await this.scope.read(async (tx) =>
      this.repo.lostFoundNear(tx, {
        origin: await this.scope.origin(tx, tenantId, query),
        radiusKm,
        kind: query.kind ?? null,
        itemType: query.itemType ?? null,
        limit,
      }),
    );
    return {
      items: rows.map((r) =>
        lostFoundCard(r, this.media.cardImage(r.photo_variants, r.photo_thumbhash)),
      ),
      radiusKm,
      next: null,
    };
  }

  async detail(id: string): Promise<LostFoundDetail> {
    this.scope.tenantId();
    const owner = await this.scope.asSystem((tx) =>
      this.repo.ownerTenant(tx, 'lost_found_items', id),
    );
    if (!owner) throw new InfoItemNotFoundException();
    const me = this.scope.context.require().userId;
    const row = await this.ownership.inTenant(owner, 'lookup', () =>
      this.scope.read((tx) => this.repo.lostFound(tx, id)),
    );
    if (!row) throw new InfoItemNotFoundException();
    const photos = await this.media.resolve(
      await this.scope.asSystem((tx) => this.repo.attachments(tx, 'lost_found_item_id', id)),
    );
    const card = lostFoundCard(
      {
        ...row,
        occurred_on: null,
        distance_m: null,
        photo_variants: null,
        photo_thumbhash: null,
      },
      photos[0] ? { url: photos[0].url, thumbhash: photos[0].thumbhash } : null,
    );
    return {
      card,
      kind: row.kind_code,
      itemType: row.item_type_code,
      description: row.description,
      locationText: row.location_text,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      reward: row.reward_amount,
      status: row.status_code,
      isMine: row.reporter_user_id === me,
      photos,
      createdAt: row.created_at.toISOString(),
    };
  }

  /** A member's report: always reviewed first (the trigger insists). */
  async create(input: LostFoundInput): Promise<Created> {
    const tenantId = this.scope.tenantId();
    const max = await this.scope.settings.get('lost_found_photos_max');
    if (input.photoIds.length > max) throw new LostFoundRefusedException('photos');
    return this.ownership.inTenant(tenantId, 'ensure', () =>
      mapInfoEngineErrors(() =>
        this.scope.write(async (tx) => {
          const created = await this.repo.insertLostFound(tx, input);
          await this.repo.attach(tx, 'lost_found_item_id', created.id, input.photoIds);
          return created;
        }),
      ),
    );
  }

  /** "Found it" / "returned": the reporter closes their own open report. */
  async resolve(id: string): Promise<void> {
    this.scope.tenantId();
    const owner = await this.scope.asSystem((tx) =>
      this.repo.ownerTenant(tx, 'lost_found_items', id),
    );
    if (!owner) throw new InfoItemNotFoundException();
    const done = await this.ownership.inTenant(owner, 'lookup', ({ memberId }) =>
      memberId
        ? mapInfoEngineErrors(() => this.scope.write((tx) => this.repo.resolveLostFound(tx, id)))
        : Promise.resolve(false),
    );
    if (!done) throw new InfoItemNotFoundException();
  }

  /** The reporter's number, as a lead (LeadGate: dedupe + per-viewer cap). */
  async contact(
    id: string,
    channel: ContactChannel,
    signals: ViewerSignals,
    locale: 'bn' | 'en',
  ): Promise<ContactReveal> {
    this.scope.tenantId();
    const owner = await this.scope.asSystem((tx) =>
      this.repo.ownerTenant(tx, 'lost_found_items', id),
    );
    if (!owner) throw new InfoItemNotFoundException();
    const key = viewerKey(this.secret, signals);
    const me = this.scope.context.require().userId;
    return this.ownership.inTenant(owner, 'lookup', async ({ memberId }) => {
      const row = await this.scope.read((tx) => this.repo.lostFound(tx, id));
      if (!row || row.status_code !== 'open') throw new InfoItemNotFoundException();
      if (row.reporter_user_id === me) throw new LostFoundRefusedException('self');
      if (!row.contact_phone_e164) throw new LostFoundRefusedException('no_phone');
      const fresh = await this.leads.count(key, channel, `lost_found:${id}`, () =>
        this.scope.write((tx) =>
          this.repo.insertLead(tx, {
            channel: LEAD_CHANNEL[channel],
            targetMemberId: row.reporter_member_id,
            actorMemberId: memberId ?? null,
            actorUserId: me ?? null,
            viewerKey: key,
          }),
        ),
      );
      if (fresh) {
        await this.notifier.lostFoundContacted(
          { userId: row.reporter_user_id, tenantId: owner, title: row.title },
          id,
          key,
        );
      }
      const message = lostFoundMessage(row.kind_code === 'found', row.title, locale);
      return {
        channel,
        name: null,
        phone: row.contact_phone_e164,
        href: contactHref(channel, row.contact_phone_e164, message),
        message: channel === 'call' ? null : message,
      };
    });
  }

  async report(id: string, input: ReportInput): Promise<void> {
    this.scope.tenantId();
    const owner = await this.scope.asSystem((tx) =>
      this.repo.ownerTenant(tx, 'lost_found_items', id),
    );
    if (!owner) throw new InfoItemNotFoundException();
    await this.ownership.inTenant(owner, 'ensure', () =>
      this.scope.write((tx) =>
        this.repo.report(tx, 'lost_found_item_id', id, input.reasonCode, input.details ?? null),
      ),
    );
  }
}

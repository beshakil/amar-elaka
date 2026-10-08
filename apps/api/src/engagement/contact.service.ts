import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { visibilityOf } from '../posts/post-visibility';
import { PostNotFoundException } from '../posts/posts.exceptions';
import { PostsRepository } from '../posts/posts.repository';
import { SettingsService } from '../settings/settings.service';
import { contactMessage } from './contact-message.templates';
import { contactHref, LEAD_CHANNEL, offeredChannels } from './contact-payload';
import type { ContactInput, ContactReveal } from './dto/engagement.dto';
import {
  ContactChannelUnavailableException,
  ContactLimitReachedException,
  ContactLoginRequiredException,
  ContactOwnPostException,
  ContactOwnStoreException,
  ContactPostNotLiveException,
  ContactStoreNotFoundException,
} from './engagement.exceptions';
import { EngagementRepository } from './engagement.repository';
import { ENGAGEMENT_STORE, type EngagementStore } from './engagement.store';
import { ShareService } from './share.service';
import { viewerKey, type ViewerSignals } from './viewer-key';

// settings-exempt: unit conversions (the limits themselves are settings)
const SECONDS_PER_MINUTE = 60;
// settings-exempt: see above; "per day" is a rolling 24 hours
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * POST /posts/:id/contact (ADR 036) — the foundation of lead billing. The
 * seller's number leaves the API only here, and every reveal is a
 * lead_events row: tenant, post, store, seller, viewer, channel, time.
 *
 * Repeat taps by one viewer on one channel within lead_dedupe_minutes return
 * the number again without a second lead (a double tap isn't two leads) and
 * without using the daily limit. New reveals are capped per viewer by
 * contact_reveals_per_user_per_day, so the endpoint can't be walked to
 * harvest numbers either.
 */
@Injectable()
export class ContactService {
  private readonly secret: string;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly ownership: PostOwnershipService,
    private readonly posts: PostsRepository,
    private readonly repo: EngagementRepository,
    private readonly share: ShareService,
    private readonly settings: SettingsService,
    @Inject(ENGAGEMENT_STORE) private readonly store: EngagementStore,
    @Inject(APP_CONFIG) env: Pick<Env, 'JWT_SECRET'>,
  ) {
    this.secret = env.JWT_SECRET;
  }

  async reveal(
    postId: string,
    input: ContactInput,
    signals: ViewerSignals,
    locale: 'bn' | 'en',
  ): Promise<ContactReveal> {
    const tenantId = await this.ownership.tenantOf(postId);
    if (!tenantId) throw new PostNotFoundException();
    if (
      !this.context.require().userId &&
      (await this.settings.get('require_login_for_contact', tenantId))
    ) {
      throw new ContactLoginRequiredException();
    }
    const key = viewerKey(this.secret, signals);

    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      const row = await this.tenantDb.transaction((tx) => this.posts.findById(tx, postId), {
        accessMode: 'read only',
      });
      if (!row) throw new PostNotFoundException();
      const facts = {
        status: row.status_code,
        hiddenByOwner: row.hidden_by_owner,
        deleted: row.deleted_at !== null,
        scrubbed: row.scrubbed_at !== null,
      };
      const isOwner = memberId !== undefined && row.author_member_id === memberId;
      if (isOwner) throw new ContactOwnPostException();
      if (visibilityOf(facts, 'public') !== 'full') throw new PostNotFoundException();
      if (row.status_code !== 'live') throw new ContactPostNotLiveException(row.status_code);

      const phone = row.contact_phone_e164;
      const offered = offeredChannels({
        hasPhone: phone !== null,
        showPhone: row.show_phone,
        showWhatsapp: row.show_whatsapp,
      });
      if (phone === null || !offered.includes(input.channel)) {
        throw new ContactChannelUnavailableException(input.channel);
      }

      await this.countLead(key, input.channel, postId, async () => {
        await this.tenantDb.transaction((tx) =>
          this.repo.insertLead(tx, {
            channel: LEAD_CHANNEL[input.channel],
            source: input.source,
            postId,
            storeId: row.store_id,
            targetMemberId: row.author_member_id,
            actorMemberId: memberId ?? null,
            viewerKey: key,
          }),
        );
      });

      const url = await this.shareUrl(tenantId, postId);
      const message = contactMessage(row.title, url, locale);
      return {
        channel: input.channel,
        name: row.contact_name,
        phone,
        href: contactHref(input.channel, phone, message),
        message: input.channel === 'call' ? null : message,
      };
    });
  }

  /**
   * POST /stores/:id/contact (ADR 054): a store's own phone or WhatsApp, the
   * same way as a post's — the only place a store's numbers leave the API,
   * each reveal a lead_events row (post_id null), with the same dedupe and
   * daily limit. Calls and SMS need the store's phone, WhatsApp its WhatsApp.
   */
  async revealStore(
    storeId: string,
    input: ContactInput,
    signals: ViewerSignals,
    locale: 'bn' | 'en',
  ): Promise<ContactReveal> {
    const tenantId = await this.tenantDb.transaction((tx) => this.repo.storeTenantOf(tx, storeId), {
      accessMode: 'read only',
    });
    if (!tenantId) throw new ContactStoreNotFoundException();
    if (
      !this.context.require().userId &&
      (await this.settings.get('require_login_for_contact', tenantId))
    ) {
      throw new ContactLoginRequiredException();
    }
    const key = viewerKey(this.secret, signals);

    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      const store = await this.tenantDb.transaction((tx) => this.repo.storeContact(tx, storeId), {
        accessMode: 'read only',
      });
      if (!store) throw new ContactStoreNotFoundException();
      if (memberId !== undefined && store.owner_member_id === memberId) {
        throw new ContactOwnStoreException();
      }
      const phone = input.channel === 'whatsapp' ? store.whatsapp_e164 : store.phone_e164;
      if (phone === null) throw new ContactChannelUnavailableException(input.channel);

      await this.countLead(key, input.channel, `store:${storeId}`, async () => {
        await this.tenantDb.transaction((tx) =>
          this.repo.insertLead(tx, {
            channel: LEAD_CHANNEL[input.channel],
            source: input.source,
            postId: null,
            storeId,
            targetMemberId: store.owner_member_id,
            actorMemberId: memberId ?? null,
            viewerKey: key,
          }),
        );
      });

      const message = contactMessage(store.name_bn, null, locale);
      return {
        channel: input.channel,
        name: store.name_bn,
        phone,
        href: contactHref(input.channel, phone, message),
        message: input.channel === 'call' ? null : message,
      };
    });
  }

  /**
   * Records the lead unless this viewer revealed this channel within
   * lead_dedupe_minutes, and enforces the daily limit on new reveals only.
   * Anything refused or failed after claiming gives the claim and the count
   * back, so a failed request never costs the viewer a reveal.
   */
  private async countLead(
    key: string,
    channel: string,
    /** The post id, or `store:<id>` for a store's own numbers. */
    target: string,
    write: () => Promise<void>,
  ): Promise<void> {
    const [dedupeMinutes, max] = await Promise.all([
      this.settings.get('lead_dedupe_minutes'),
      this.settings.get('contact_reveals_per_user_per_day'),
    ]);
    const claim = `lead:${target}:${channel}:${key}`;
    if (
      dedupeMinutes > 0 &&
      !(await this.store.claimOnce(claim, dedupeMinutes * SECONDS_PER_MINUTE))
    ) {
      return; // a repeat tap: same lead, no new row
    }
    const rate = `contact-rate:${key}`;
    const used = await this.store.count(rate, SECONDS_PER_DAY);
    try {
      if (used > max) throw new ContactLimitReachedException(max);
      await write();
    } catch (error) {
      await this.store.uncount(rate);
      if (dedupeMinutes > 0) await this.store.release(claim);
      throw error;
    }
  }

  private async shareUrl(tenantId: string, postId: string): Promise<string | null> {
    const slug = await this.tenantDb.transaction((tx) => this.repo.tenantSlug(tx, tenantId), {
      accessMode: 'read only',
    });
    if (!slug) return null;
    return this.share.urlFor(slug, await this.share.codeFor(postId));
  }
}

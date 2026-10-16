import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { contactHref, LEAD_CHANNEL } from '../engagement/contact-payload';
import { LeadGate } from '../engagement/lead-gate';
import { viewerKey, type ViewerSignals } from '../engagement/viewer-key';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { isStaffRole } from '../posts/post-visibility';
import { SettingsService } from '../settings/settings.service';
import { BloodAlertsService } from './blood-alerts.service';
import { BLOOD_GROUP_SYMBOL, decodeDonorCursor, encodeDonorCursor } from './blood-groups';
import { donorContactMessage, requesterContactMessage } from './blood-message.templates';
import { BloodNotifier } from './blood-notifier';
import type {
  BloodGroup,
  BloodRequestCard,
  BloodRequestDetail,
  BloodRequestList,
  BloodRequestListQuery,
  CreateBloodRequestInput,
  CreatedBloodRequest,
  DonorContactInput,
  DonorContactResult,
  DonorContacts,
  DonorPage,
  DonorSearchQuery,
  MyDonor,
  RegisterDonorInput,
} from './dto/info.dto';
import type { ContactReveal, ContactChannel } from '../engagement/dto/engagement.dto';
import {
  BloodRequestNotFoundException,
  BloodRequestRefusedException,
  DonorContactRefusedException,
  DonorNotFoundException,
  DonorNotRegisteredException,
  InfoAreaRequiredException,
  InfoStaffOnlyException,
  mapInfoErrors,
} from './info.exceptions';
import { InfoRepository, type Origin, type RequestRow } from './info.repository';

// settings-exempt: unit conversion (the limits themselves are settings)
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Blood donors and urgent requests (ADR 064).
 *  - Donors opt in (consent recorded), choose when they may be contacted and
 *    pause instantly. A recorded donation takes them off the list for
 *    blood_donation_interval_days (eligible_from, by trigger).
 *  - The list is radius-based across areas, signed-in users only, never with
 *    a number. Contacting a donor is a tracked lead (LeadGate + the donor's
 *    own daily cap): their number only if they share it, else they are asked
 *    in-app — and every contact shows in their "who contacted me".
 *  - An urgent request alerts matching donors near the hospital at once
 *    (BloodAlertsService) and closes on its own after its time.
 */
@Injectable()
export class BloodService {
  private readonly logger = new Logger(BloodService.name);
  private readonly secret: string;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly ownership: PostOwnershipService,
    private readonly repo: InfoRepository,
    private readonly settings: SettingsService,
    private readonly leads: LeadGate,
    private readonly alerts: BloodAlertsService,
    private readonly notifier: BloodNotifier,
    @Inject(APP_CONFIG) env: Pick<Env, 'JWT_SECRET'>,
  ) {
    this.secret = env.JWT_SECRET;
  }

  // ---- donors: search ---------------------------------------------------------

  async searchDonors(query: DonorSearchQuery): Promise<DonorPage> {
    const tenantId = this.requireTenant();
    const [defaultRadius, maxRadius, limit] = await Promise.all([
      this.settings.get('blood_search_radius_km', tenantId),
      this.settings.get('blood_search_max_radius_km'),
      this.settings.get('blood_page_size_max'),
    ]);
    const radiusKm = Math.min(query.radius_km ?? defaultRadius, maxRadius);
    const rows = await this.readOnly(async (tx) => {
      const origin = await this.origin(tx, tenantId, query);
      const groups = query.compatible
        ? await this.repo.compatibleDonorGroups(tx, query.group)
        : [query.group];
      return this.repo.donorsNear(tx, {
        origin,
        radiusKm,
        groups,
        after: query.after ? decodeDonorCursor(query.after) : null,
        limit,
      });
    });
    const last = rows.at(-1);
    return {
      items: rows.map((r) => ({
        id: r.id,
        bloodGroup: r.blood_group_code,
        displayName: r.display_name,
        area: r.area_bn === null && r.area_en === null ? null : { bn: r.area_bn, en: r.area_en },
        distanceMeters: Math.round(r.distance_m),
        contactWindow: r.contact_window_code,
        contactPreference: r.contact_preference_code,
        lastDonatedOn: r.last_donated_on,
      })),
      radiusKm,
      next: last && rows.length >= limit ? encodeDonorCursor(last.distance_m, last.id) : null,
    };
  }

  // ---- donors: the caller's own registration ---------------------------------

  async me(): Promise<MyDonor> {
    const tenantId = this.requireTenant();
    const cap = await this.settings.get('blood_donor_daily_contact_cap', tenantId);
    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      if (!memberId) return { donor: null };
      const row = await this.readOnly((tx) => this.repo.myDonor(tx));
      if (!row) return { donor: null };
      return {
        donor: {
          id: row.id,
          bloodGroup: row.blood_group_code,
          localityId: row.locality_id,
          location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
          lastDonatedOn: row.last_donated_on,
          eligibleFrom: row.eligible_from,
          isAvailable: row.is_available,
          isListed: row.is_listed,
          contactWindow: row.contact_window_code,
          contactPreference: row.contact_preference_code,
          alertsEnabled: row.alerts_enabled,
          contactsToday: row.contacts_today,
          dailyContactCap: cap,
        },
      };
    });
  }

  /** Opt in (or change the details); the listing consent is recorded on the first registration. */
  async register(
    input: RegisterDonorInput,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<MyDonor> {
    const tenantId = this.requireTenant();
    await this.ownership.inTenant(tenantId, 'ensure', () =>
      this.tenantDb.transaction(async (tx) => {
        if (
          input.lastDonatedOn &&
          input.lastDonatedOn > (await this.repo.localToday(tx, tenantId))
        ) {
          throw new BloodRequestRefusedException('donation_date');
        }
        const existing = await this.repo.myDonor(tx);
        await this.repo.upsertDonor(tx, input);
        if (!existing) await this.repo.recordDonorConsent(tx, meta);
      }),
    );
    return this.me();
  }

  /** Pause or resume at once: a paused donor is off every list and gets no alerts. */
  async setAvailability(available: boolean): Promise<MyDonor> {
    await this.asMember((tx) => this.repo.setAvailability(tx, available));
    return this.me();
  }

  async recordDonation(donatedOn: string): Promise<MyDonor> {
    const tenantId = this.requireTenant();
    await this.asMember(async (tx) => {
      if (donatedOn > (await this.repo.localToday(tx, tenantId))) {
        throw new BloodRequestRefusedException('donation_date');
      }
      return this.repo.recordDonation(tx, donatedOn);
    });
    return this.me();
  }

  /** Leaves the donor list (the row is kept, soft-deleted). */
  async withdraw(): Promise<void> {
    await this.asMember((tx) => this.repo.withdrawDonor(tx));
  }

  async myContacts(): Promise<DonorContacts> {
    const tenantId = this.requireTenant();
    const limit = await this.settings.get('blood_page_size_max');
    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      if (!memberId) return { items: [] };
      const rows = await this.readOnly((tx) => this.repo.myDonorContacts(tx, limit));
      return {
        items: rows.map((r) => ({
          id: r.id,
          at: r.created_at.toISOString(),
          requesterName: r.requester_name,
          channel: r.channel_code,
          request:
            r.request_id === null
              ? null
              : {
                  id: r.request_id,
                  bloodGroup: r.request_group!,
                  hospitalName: r.request_hospital!,
                  neededBy: r.request_needed_by!.toISOString(),
                  status: r.request_status!,
                },
        })),
      };
    });
  }

  // ---- donors: contact ----------------------------------------------------------

  /**
   * The tracked contact (ADR 064). A donor who shares their number: it is
   * returned with a tel:/sms:/wa.me link. Otherwise: they are notified and
   * will get back. Either way a lead and a "who contacted me" row, under the
   * donor's daily cap and the viewer's (LeadGate).
   */
  async contactDonor(
    donorId: string,
    input: DonorContactInput,
    signals: ViewerSignals,
    locale: 'bn' | 'en',
  ): Promise<DonorContactResult> {
    this.requireTenant();
    const tenantId = await mapInfoErrors(() =>
      this.readOnly((tx) => this.repo.donorTenant(tx, donorId)),
    );
    if (!tenantId) throw new DonorNotFoundException();
    const key = viewerKey(this.secret, signals);
    const me = this.context.require().userId;

    return this.ownership.inTenant(tenantId, 'lookup', async () => {
      const target = await mapInfoErrors(() =>
        this.readOnly((tx) => this.repo.donorContactTarget(tx, donorId)),
      );
      if (!target) throw new DonorNotFoundException();
      if (target.user_id === me) throw new DonorContactRefusedException('self');
      const shares = target.contact_preference_code === 'reveal_on_request' && target.phone_e164;
      const channel = shares ? LEAD_CHANNEL[input.channel] : 'donor_request';

      const recorded: { id: string | null } = { id: null };
      await this.leads.count(key, channel, `donor:${donorId}`, async () => {
        recorded.id = await mapInfoErrors(() =>
          this.tenantDb.transaction((tx) =>
            this.repo.recordDonorContact(tx, {
              donorId,
              channel,
              requestId: input.requestId ?? null,
              viewerKey: key,
            }),
          ),
        );
      });
      if (recorded.id) {
        await this.notifier.contacted(target.user_id, tenantId, recorded.id, {
          requesterName: await this.myDisplayName(),
          hospital: input.requestId ? await this.hospitalOf(input.requestId) : null,
        });
      }
      if (!shares) return { mode: 'asked' as const, reveal: null };
      const message = donorContactMessage(groupSymbol(target.blood_group_code), locale);
      return {
        mode: 'phone' as const,
        reveal: reveal(input.channel, target.display_name, target.phone_e164!, message),
      };
    });
  }

  // ---- urgent requests ---------------------------------------------------------

  async createRequest(input: CreateBloodRequestInput): Promise<CreatedBloodRequest> {
    const tenantId = this.requireTenant();
    const userId = this.context.require().userId!;
    const [maxAheadHours, maxOpen] = await Promise.all([
      this.settings.get('blood_request_max_ahead_hours'),
      this.settings.get('blood_request_max_open_per_user'),
    ]);
    const neededBy = new Date(input.neededBy);
    const now = Date.now();
    if (neededBy.getTime() <= now || neededBy.getTime() > now + maxAheadHours * MS_PER_HOUR) {
      throw new BloodRequestRefusedException('needed_by');
    }
    const id = await this.ownership.inTenant(tenantId, 'ensure', () =>
      this.tenantDb.transaction(async (tx) => {
        if ((await this.repo.openRequestCount(tx, userId)) >= maxOpen) {
          throw new BloodRequestRefusedException('too_many_open');
        }
        return this.repo.insertRequest(tx, {
          bloodGroup: input.bloodGroup,
          units: input.units,
          hospitalName: input.hospitalName,
          hospitalPlaceId: input.hospitalPlaceId ?? null,
          location: input.location,
          neededBy: neededBy.toISOString(),
          urgency: input.urgency,
          patientNote: input.patientNote ?? null,
          contactPhone: input.contactPhone ?? null,
        });
      }),
    );
    let alertedDonors = 0;
    try {
      alertedDonors = await this.alerts.alert(id);
    } catch (error) {
      // The request stands; the alert-blood-donors job matches it on its next run.
      this.logger.warn(`could not alert donors for ${id}: ${String(error)}`);
    }
    return { id, alertedDonors };
  }

  async listRequests(query: BloodRequestListQuery): Promise<BloodRequestList> {
    const tenantId = this.requireTenant();
    const [defaultRadius, maxRadius, limit] = await Promise.all([
      this.settings.get('blood_search_radius_km', tenantId),
      this.settings.get('blood_search_max_radius_km'),
      this.settings.get('blood_page_size_max'),
    ]);
    const radiusKm = Math.min(query.radius_km ?? defaultRadius, maxRadius);
    const rows = await this.readOnly(async (tx) => {
      const origin = await this.origin(tx, tenantId, query);
      return this.repo.requestsNear(tx, {
        origin,
        radiusKm,
        groups: query.group ? [query.group] : null,
        limit,
      });
    });
    return {
      radiusKm,
      items: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        bloodGroup: r.blood_group_code,
        units: r.units_needed,
        hospitalName: r.hospital_name,
        neededBy: r.needed_by.toISOString(),
        urgency: r.urgency_code,
        status: 'open',
        createdAt: r.created_at.toISOString(),
        distanceMeters: Math.round(r.distance_m),
        isMine: r.is_mine,
      })),
    };
  }

  async myRequests(): Promise<BloodRequestList> {
    const tenantId = this.requireTenant();
    const limit = await this.settings.get('blood_page_size_max');
    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      if (!memberId) return { items: [], radiusKm: null };
      const rows = await this.readOnly((tx) => this.repo.myRequests(tx, limit));
      return { items: rows.map((r) => toCard(r, true)), radiusKm: null };
    });
  }

  async requestDetail(id: string): Promise<BloodRequestDetail> {
    const tenantId = await this.requestTenant(id);
    const me = this.context.require().userId;
    return this.ownership.inTenant(tenantId, 'lookup', async () => {
      const row = await this.readOnly((tx) => this.repo.request(tx, id));
      if (!row) throw new BloodRequestNotFoundException();
      const isMine = row.requester_user_id === me;
      const alertedDonors = isMine
        ? await this.context.run({ role: 'system' }, () =>
            this.readOnly((tx) => this.repo.alertCount(tx, id)),
          )
        : null;
      return {
        ...toCard(row, isMine),
        patientNote: row.patient_note,
        location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
        requesterName: row.requester_name,
        alertedDonors,
      };
    });
  }

  /** A donor reaching the person who posted the request: their number, as a lead. */
  async contactRequester(
    id: string,
    channel: ContactChannel,
    signals: ViewerSignals,
    locale: 'bn' | 'en',
  ): Promise<ContactReveal> {
    const tenantId = await this.requestTenant(id);
    const key = viewerKey(this.secret, signals);
    const me = this.context.require().userId;
    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      const row = await this.readOnly((tx) => this.repo.request(tx, id));
      if (!row) throw new BloodRequestNotFoundException();
      if (row.requester_user_id === me) throw new BloodRequestRefusedException('self');
      if (row.status_code !== 'open') throw new BloodRequestRefusedException('closed');
      await this.leads.count(key, channel, `blood_request:${id}`, () =>
        this.tenantDb.transaction((tx) =>
          this.repo.insertRequestLead(tx, {
            channel: LEAD_CHANNEL[channel],
            targetMemberId: row.requester_member_id,
            actorMemberId: memberId ?? null,
            actorUserId: me ?? null,
            viewerKey: key,
          }),
        ),
      );
      const message = requesterContactMessage(
        groupSymbol(row.blood_group_code),
        row.hospital_name,
        locale,
      );
      return reveal(channel, row.requester_name, row.contact_phone_e164, message);
    });
  }

  async closeRequest(id: string, outcome: 'fulfilled' | 'cancelled'): Promise<void> {
    const tenantId = await this.requestTenant(id);
    await this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      if (!memberId) throw new BloodRequestNotFoundException();
      const closed = await this.tenantDb.transaction((tx) =>
        this.repo.closeRequest(tx, id, outcome),
      );
      if (!closed) throw new BloodRequestNotFoundException();
    });
  }

  // ---- the area's moderators ------------------------------------------------------

  async areaRequests(): Promise<BloodRequestList> {
    this.requireStaff();
    const limit = await this.settings.get('blood_page_size_max');
    const rows = await this.readOnly((tx) => this.repo.areaRequests(tx, limit));
    return { items: rows.map((r) => toCard(r, false)), radiusKm: null };
  }

  /** A takedown: status removed + moderation_actions, one transaction (remove_blood_request). */
  async removeRequest(id: string, reasonCode: string, reasonText: string): Promise<void> {
    this.requireStaff();
    await mapInfoErrors(() =>
      this.tenantDb.transaction((tx) => this.repo.removeRequest(tx, id, reasonCode, reasonText)),
    );
  }

  // ---- helpers ------------------------------------------------------------------

  private async origin(
    tx: DatabaseTransaction,
    tenantId: string,
    q: { lat?: number | undefined; lng?: number | undefined },
  ): Promise<Origin> {
    if (q.lat !== undefined && q.lng !== undefined) return { lat: q.lat, lng: q.lng };
    const center = await this.repo.tenantCenter(tx, tenantId);
    if (!center) throw new InfoAreaRequiredException();
    return center;
  }

  private async requestTenant(id: string): Promise<string> {
    this.requireTenant();
    const tenantId = await this.readOnly((tx) => this.repo.requestTenant(tx, id));
    if (!tenantId) throw new BloodRequestNotFoundException();
    return tenantId;
  }

  /** Work on the caller's own donor row in this area. */
  private async asMember(work: (tx: DatabaseTransaction) => Promise<boolean>): Promise<void> {
    const tenantId = this.requireTenant();
    await this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      if (!memberId) throw new DonorNotRegisteredException();
      const found = await this.tenantDb.transaction(work);
      if (!found) throw new DonorNotRegisteredException();
    });
  }

  private async myDisplayName(): Promise<string | null> {
    return this.readOnly((tx) => this.repo.myDisplayName(tx));
  }

  private async hospitalOf(requestId: string): Promise<string | null> {
    return this.context.run({ role: 'system' }, () =>
      this.readOnly(async (tx) => (await this.repo.request(tx, requestId))?.hospital_name ?? null),
    );
  }

  private requireTenant(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new InfoAreaRequiredException();
    return tenantId;
  }

  private requireStaff(): void {
    this.requireTenant();
    if (!isStaffRole(this.context.require().role)) throw new InfoStaffOnlyException();
  }

  private readOnly<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }
}

function groupSymbol(code: string): string {
  return BLOOD_GROUP_SYMBOL[code as BloodGroup] ?? code;
}

function reveal(
  channel: ContactChannel,
  name: string | null,
  phone: string,
  message: string,
): ContactReveal {
  return {
    channel,
    name,
    phone,
    href: contactHref(channel, phone, message),
    message: channel === 'call' ? null : message,
  };
}

function toCard(r: RequestRow, isMine: boolean): BloodRequestCard {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    bloodGroup: r.blood_group_code,
    units: r.units_needed,
    hospitalName: r.hospital_name,
    neededBy: r.needed_by.toISOString(),
    urgency: r.urgency_code,
    status: r.status_code,
    createdAt: r.created_at.toISOString(),
    distanceMeters: null,
    isMine,
  };
}

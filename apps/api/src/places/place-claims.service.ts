import { Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { OtpService, type OtpPurpose } from '../auth/otp/otp.service';
import { sqlStateOf } from '../common/utils/sql-state';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { NotificationService } from '../notifications/notification.service';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { SettingsService } from '../settings/settings.service';
import type {
  ApproveClaimInput,
  ClaimDecisionResult,
  ClaimOtpInput,
  ClaimOtpSent,
  ClaimQueuePage,
  ClaimView,
  CreateClaimInput,
  PageQuery,
  RejectClaimInput,
} from './dto/places.dto';
import { maskPhone, OPEN_STATES } from './place-view';
import {
  ClaimAlreadyPendingException,
  ClaimDecisionForbiddenException,
  ClaimEvidenceNotAcceptedException,
  ClaimNotFoundException,
  ClaimNotPendingException,
  ClaimNoteTooLongException,
  ClaimPhoneUnavailableException,
  ClaimStoreNotLinkableException,
  PlaceAlreadyClaimedException,
  PlaceMediaInvalidException,
  PlaceNotClaimableException,
  PlaceNotFoundException,
  TooManyClaimDocumentsException,
} from './places.exceptions';
import {
  PlacesRepository,
  type ApprovedClaim,
  type ClaimRow,
  type PlaceRow,
} from './places.repository';

const UNIQUE_VIOLATION = '23505';
// approve_place_claim's SQLSTATEs (0042).
const CLAIM_ERRORS: Record<string, () => Error> = {
  P0002: () => new ClaimNotFoundException(),
  '42501': () => new ClaimDecisionForbiddenException(),
  AE210: () => new ClaimNotPendingException(),
  AE211: () => new PlaceAlreadyClaimedException(),
  AE212: () => new PlaceNotClaimableException(),
  AE213: () => new ClaimStoreNotLinkableException(),
  AE214: () => new ClaimDecisionForbiddenException(),
  // place_claims_one_approved_uq: a concurrent approval won the race.
  [UNIQUE_VIOLATION]: () => new PlaceAlreadyClaimedException(),
};

type Evidence = 'otp_to_listed_phone' | 'shop_front_photo' | 'trade_license';

/**
 * "এই দোকানটি আমার" — a member claims a place they own (ADR 047).
 *
 * Evidence, at least one, from what the place's tenant accepts
 * (place_claim_evidence_methods): an OTP sent to a number already on the
 * place, photos of the owner at the shop front, trade licence pages (both
 * uploaded as private `document` media). An OTP-verified claim is approved at
 * once when the tenant allows it (place_claim_otp_auto_approve); every other
 * claim waits in the moderators' queue. Approval is one database transaction
 * (approve_place_claim, 0042): store created or linked, the place becomes its
 * map pin, saves and reviews carried over, competing claims rejected, all in
 * moderation_actions. Notifications go out after commit.
 */
@Injectable()
export class PlaceClaimsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: PlacesRepository,
    private readonly ownership: PostOwnershipService,
    private readonly settings: SettingsService,
    private readonly otp: OtpService,
    private readonly notifications: NotificationService,
  ) {}

  /** Sends the claim code to one of the place's own numbers. */
  async requestOtp(placeId: string, input: ClaimOtpInput, ip: string): Promise<ClaimOtpSent> {
    const userId = this.requireUserId();
    const tenantId = await this.tenantOf(placeId);
    await this.checkAccepted(tenantId, ['otp_to_listed_phone']);
    const phone = await this.ownership.inTenant(tenantId, 'lookup', async () => {
      const place = await this.claimablePlace(placeId);
      const number = place.phones[input.phoneIndex];
      if (number === undefined) throw new ClaimPhoneUnavailableException();
      return number;
    });
    const sent = await this.otp.requestOtp(phone, ip, claimPurpose(userId, placeId));
    return { sentTo: maskPhone(phone), resendAfterSeconds: sent.resendAfterSeconds };
  }

  async create(placeId: string, input: CreateClaimInput): Promise<ClaimView> {
    const userId = this.requireUserId();
    const tenantId = await this.tenantOf(placeId);
    const { evidence } = input;
    const offered: Evidence[] = [
      ...(evidence.otp ? (['otp_to_listed_phone'] as const) : []),
      ...((evidence.shopFrontPhotos?.length ?? 0) > 0 ? (['shop_front_photo'] as const) : []),
      ...((evidence.tradeLicence?.length ?? 0) > 0 ? (['trade_license'] as const) : []),
    ];
    await this.checkAccepted(tenantId, offered);
    const documents = [
      ...new Set([...(evidence.shopFrontPhotos ?? []), ...(evidence.tradeLicence ?? [])]),
    ];
    const [maxDocuments, maxNote] = await Promise.all([
      this.settings.get('place_claim_max_documents'),
      this.settings.get('place_claim_note_max_length'),
    ]);
    if (documents.length > maxDocuments) throw new TooManyClaimDocumentsException(maxDocuments);
    if (input.note !== undefined && [...input.note].length > maxNote) {
      throw new ClaimNoteTooLongException(maxNote);
    }

    const { claimId, approved } = await this.ownership.inTenant(
      tenantId,
      'ensure',
      async ({ memberId }) => {
        const place = await this.claimablePlace(placeId);
        // Single-use: checked last before writing, after every cheap refusal.
        let otpPhone: string | null = null;
        if (evidence.otp) {
          const phone = place.phones[evidence.otp.phoneIndex];
          if (phone === undefined) throw new ClaimPhoneUnavailableException();
          await this.otp.verifyOtp(phone, evidence.otp.code, claimPurpose(userId, placeId));
          otpPhone = phone;
        }
        const autoApprove =
          otpPhone !== null && (await this.settings.get('place_claim_otp_auto_approve', tenantId));

        return this.tenantDb.transaction(async (tx) => {
          const usable = new Set(await this.repo.usableMedia(tx, documents, userId, 'document'));
          const missing = documents.filter((id) => !usable.has(id));
          if (missing.length > 0) throw new PlaceMediaInvalidException(missing);

          let id: string;
          try {
            id = await this.repo.insertClaim(tx, {
              placeId,
              claimantMemberId: memberId!,
              verificationMethod: offered[0]!,
              evidenceCodes: offered,
              otpVerifiedPhone: otpPhone,
              note: input.note ?? null,
            });
          } catch (error) {
            if (sqlStateOf(error) === UNIQUE_VIOLATION) throw new ClaimAlreadyPendingException();
            throw error;
          }
          await this.repo.attachMedia(tx, { placeClaimId: id }, documents);
          await this.repo.recordAction(tx, {
            target: { placeClaimId: id },
            actorUserId: userId,
            actionCode: 'claim_submitted',
            reasonCode: 'owner_request',
            reasonText: null,
            evidenceRefs: [{ evidence: offered, documents }],
          });
          const result = autoApprove ? await this.approveIn(tx, id, null, true) : null;
          return { claimId: id, approved: result };
        });
      },
    );
    if (approved) await this.notifyApproval(approved);
    return this.view(tenantId, claimId);
  }

  // ---- moderators ----------------------------------------------------------

  async queue(query: PageQuery): Promise<ClaimQueuePage> {
    this.requireStaffContext();
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('moderation_queue_page_size_default'),
      this.settings.get('moderation_queue_page_size_max'),
    ]);
    const limit = Math.min(query.limit ?? pageDefault, pageMax);
    const rows = await this.tenantDb.transaction(
      (tx) => this.repo.claimQueue(tx, query.cursor ?? null, limit + 1),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        place: { id: r.place_id, nameBn: r.place_name_bn, phones: r.place_phones },
        claimantMemberId: r.claimant_member_id,
        claimantUserId: r.claimant_user_id,
        evidence: r.evidence_codes,
        otpVerifiedPhone: r.otp_verified_phone_e164,
        documentIds: r.document_ids,
        note: r.claimant_note,
        competingClaims: r.competing,
        queuedAt: r.created_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async approve(claimId: string, input: ApproveClaimInput): Promise<ClaimDecisionResult> {
    this.requireStaffContext();
    const approved = await this.tenantDb.transaction(async (tx) => {
      const result = await this.approveIn(tx, claimId, input.storeId ?? null, false);
      if (input.note) await this.repo.setReviewNote(tx, claimId, input.note);
      return result;
    });
    await this.notifyApproval(approved);
    return {
      claimId,
      status: 'approved',
      storeId: approved.storeId,
      supersededClaimIds: approved.supersededClaimIds,
    };
  }

  async reject(claimId: string, input: RejectClaimInput): Promise<ClaimDecisionResult> {
    const { tenantId, userId, memberId } = this.requireStaffContext();
    const maxNote = await this.settings.get('place_claim_note_max_length');
    if (input.reasonText !== undefined && [...input.reasonText].length > maxNote) {
      throw new ClaimNoteTooLongException(maxNote);
    }
    const { claim, place, claimantUserId } = await this.tenantDb.transaction(async (tx) => {
      const row = await this.repo.findClaim(tx, claimId, { forUpdate: true });
      if (!row || row.tenant_id !== tenantId) throw new ClaimNotFoundException();
      if (row.claimant_member_id === memberId) throw new ClaimDecisionForbiddenException();
      if (row.status_code !== 'pending') throw new ClaimNotPendingException();
      await this.repo.rejectClaim(tx, claimId, {
        reasonCode: input.reasonCode,
        note: input.reasonText ?? null,
        userId,
      });
      await this.repo.recordAction(tx, {
        target: { placeClaimId: claimId },
        actorUserId: userId,
        actionCode: 'claim_rejected',
        reasonCode: input.reasonCode,
        reasonText: input.reasonText ?? null,
        evidenceRefs: [],
      });
      return {
        claim: row,
        place: await this.repo.find(tx, row.place_id),
        claimantUserId: await this.repo.userOfMember(tx, row.claimant_member_id),
      };
    });
    if (claimantUserId) {
      await this.notifyRejected(claimantUserId, claim, place, input.reasonCode, input.reasonText);
    }
    return { claimId, status: 'rejected', storeId: null, supersededClaimIds: [] };
  }

  // ---- helpers -------------------------------------------------------------

  private async approveIn(
    tx: DatabaseTransaction,
    claimId: string,
    storeId: string | null,
    auto: boolean,
  ): Promise<ApprovedClaim> {
    try {
      return await this.repo.approveClaim(tx, claimId, storeId, auto);
    } catch (error) {
      const mapped = CLAIM_ERRORS[sqlStateOf(error) ?? ''];
      throw mapped ? mapped() : error;
    }
  }

  /** The place, readable by the caller, published and not yet claimed. */
  private claimablePlace(placeId: string): Promise<PlaceRow> {
    return this.tenantDb.transaction(
      async (tx) => {
        const place = await this.repo.find(tx, placeId);
        if (!place || place.deleted_at !== null) throw new PlaceNotFoundException();
        if (place.claimed_by_member_id !== null) throw new PlaceAlreadyClaimedException();
        if (!OPEN_STATES.includes(place.status_code)) throw new PlaceNotClaimableException();
        return place;
      },
      { accessMode: 'read only' },
    );
  }

  private async checkAccepted(tenantId: string, offered: readonly Evidence[]): Promise<void> {
    const accepted = await this.settings.get('place_claim_evidence_methods', tenantId);
    const notAccepted = offered.filter((code) => !accepted.includes(code));
    if (notAccepted.length > 0) throw new ClaimEvidenceNotAcceptedException(notAccepted, accepted);
  }

  private async view(tenantId: string, claimId: string): Promise<ClaimView> {
    const row = await this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction((tx) => this.repo.findClaim(tx, claimId), {
        accessMode: 'read only',
      }),
    );
    if (!row) throw new ClaimNotFoundException();
    return {
      id: row.id,
      placeId: row.place_id,
      status: row.status_code,
      evidence: row.evidence_codes,
      otpVerified: row.otp_verified_phone_e164 !== null,
      storeId: row.store_id,
      rejectionReason: row.rejection_reason_code,
      createdAt: row.created_at.toISOString(),
      reviewedAt: row.reviewed_at?.toISOString() ?? null,
    };
  }

  private async notifyApproval(approved: ApprovedClaim): Promise<void> {
    // The name, so the inbox can say which place (the clients render from params).
    const place = await this.tenantDb.transaction((tx) => this.repo.find(tx, approved.placeId), {
      accessMode: 'read only',
    });
    const placeName = place?.name_bn ?? null;
    if (approved.claimantUserId) {
      await this.notifications.send({
        userId: approved.claimantUserId,
        type: 'place_claim_approved',
        params: { placeId: approved.placeId, placeName, storeId: approved.storeId },
        deepLink: `/places/${approved.placeId}`,
        entityId: approved.placeId,
        dedupeKey: `place_claim_approved:${approved.placeId}:${approved.storeId}`,
      });
    }
    for (const [i, userId] of approved.supersededUserIds.entries()) {
      await this.notifications.send({
        userId,
        type: 'place_claim_rejected',
        params: {
          placeId: approved.placeId,
          placeName,
          reasonCode: 'place_already_claimed',
          reasonText: null,
        },
        deepLink: `/places/${approved.placeId}`,
        entityId: approved.placeId,
        dedupeKey: `place_claim_rejected:${approved.supersededClaimIds[i] ?? approved.placeId}`,
      });
    }
  }

  private async notifyRejected(
    userId: string,
    claim: ClaimRow,
    place: PlaceRow | undefined,
    reasonCode: string,
    reasonText: string | undefined,
  ): Promise<void> {
    await this.notifications.send({
      userId,
      type: 'place_claim_rejected',
      params: {
        placeId: claim.place_id,
        placeName: place?.name_bn ?? null,
        reasonCode,
        reasonText: reasonText ?? null,
      },
      deepLink: `/places/${claim.place_id}`,
      entityId: claim.place_id,
      dedupeKey: `place_claim_rejected:${claim.id}`,
    });
  }

  private async tenantOf(placeId: string): Promise<string> {
    const tenantId = await this.tenantDb.transaction((tx) => this.repo.tenantOf(tx, placeId), {
      accessMode: 'read only',
    });
    if (!tenantId) throw new PlaceNotFoundException();
    return tenantId;
  }

  private requireUserId(): string {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }

  private requireStaffContext(): {
    tenantId: string;
    userId: string;
    memberId: string | undefined;
  } {
    const { tenantId, userId, memberId } = this.context.require();
    if (!userId) throw new UnauthenticatedException();
    if (!tenantId) throw new TenantRequiredException();
    return { tenantId, userId, memberId };
  }
}

/** A claim code is bound to the claimant and the place (OtpService purpose). */
function claimPurpose(userId: string, placeId: string): OtpPurpose {
  return { kind: 'place_claim', scope: `${userId}:${placeId}` };
}

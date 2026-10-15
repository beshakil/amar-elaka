import { Inject, Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { sqlStateOf } from '../common/utils/sql-state';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { MediaService } from '../media/media.service';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { MediaAssetNotFoundException } from '../storage/storage.exceptions';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  BusinessInput,
  EvidencePresigned,
  EvidencePresignInput,
  EvidenceStatus,
  IdentityInput,
  MyVerification,
  MyVerifications,
  StoreVerification,
} from './dto/verification.dto';
import { hashNid, normalizeNid } from './nid';
import {
  sqlDetailOf,
  verificationError,
  VerificationNidInvalidException,
  VerificationStoreNotFoundException,
} from './verification.exceptions';
import { VerificationRepository, type MineRow } from './verification.repository';

/**
 * Verification for members and store owners (ADR 062). Identity is the
 * person's: requested in the caller's own area, reviewed by its moderators,
 * valid everywhere. A store's business verification runs in the store's
 * area. The rules are the 0058 functions'; the NID number is hashed here and
 * goes no further (nid.ts). Evidence is uploaded through the media pipeline
 * as private files — a photo as `verification_image` (re-encoded, metadata
 * gone), a PDF licence as `document` — in the area that will review it.
 */
@Injectable()
export class VerificationService {
  private readonly pepper: string;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly ownership: PostOwnershipService,
    private readonly repo: VerificationRepository,
    private readonly media: MediaService,
    @Inject(APP_CONFIG) env: Pick<Env, 'NID_HASH_SECRET'>,
  ) {
    this.pepper = env.NID_HASH_SECRET;
  }

  async mine(): Promise<MyVerifications> {
    const userId = this.requireUser();
    this.tenantId();
    return this.read(async (tx) => {
      const rows = await this.repo.mine(tx);
      return {
        level: await this.repo.userLevel(tx, userId),
        identityRequest: await this.repo.canRequest(tx, 'member', userId),
        items: rows.filter((r) => r.subject_type === 'member').map(view),
      };
    });
  }

  async submitIdentity(input: IdentityInput): Promise<{ id: string; status: 'submitted' }> {
    this.requireUser();
    this.tenantId();
    const nid = normalizeNid(input.nid);
    if (!nid) throw new VerificationNidInvalidException();
    const { hash, last3 } = hashNid(nid, this.pepper);
    const created = await this.write(() =>
      this.tenantDb.transaction((tx) =>
        this.repo.submitIdentity(tx, {
          nidHash: hash,
          nidLast3: last3,
          selfieMediaId: input.selfieMediaId,
        }),
      ),
    );
    return { id: created.id, status: 'submitted' };
  }

  async store(storeId: string): Promise<StoreVerification> {
    this.requireUser();
    const tenantId = await this.storeTenant(storeId);
    return this.ownership.inTenant(tenantId, 'lookup', () =>
      this.read(async (tx) => {
        const rows = await this.repo.mine(tx);
        const ownerLevel = await this.repo.userLevel(tx, this.context.require().userId!);
        return {
          level: await this.repo.storeLevel(tx, storeId),
          request: await this.repo.canRequest(tx, 'store', storeId),
          ownerIdentityChecked: ownerLevel === 'identity_checked',
          items: rows
            .filter((r) => r.subject_type === 'store' && r.subject_id === storeId)
            .map(view),
        };
      }),
    );
  }

  async submitBusiness(
    storeId: string,
    input: BusinessInput,
  ): Promise<{ id: string; status: 'submitted' }> {
    this.requireUser();
    const tenantId = await this.storeTenant(storeId);
    const id = await this.ownership.inTenant(tenantId, 'lookup', () =>
      this.write(() =>
        this.tenantDb.transaction((tx) =>
          this.repo.submitBusiness(tx, {
            storeId,
            licenceMediaId: input.licenceMediaId,
            shopFrontMediaId: input.shopFrontMediaId,
          }),
        ),
      ),
    );
    return { id, status: 'submitted' };
  }

  // ---- evidence: the media pipeline, private, in the reviewing area ----------

  /** Identity evidence: in the caller's own area. */
  presignOwn(input: EvidencePresignInput): Promise<EvidencePresigned> {
    this.requireUser();
    this.tenantId();
    return this.presign(input);
  }

  confirmOwn(mediaId: string): Promise<EvidenceStatus> {
    this.requireUser();
    this.tenantId();
    return this.confirm(mediaId);
  }

  statusOwn(mediaId: string): Promise<EvidenceStatus> {
    this.requireUser();
    this.tenantId();
    return this.status(mediaId);
  }

  /** Business evidence: in the store's area. */
  async presignForStore(storeId: string, input: EvidencePresignInput): Promise<EvidencePresigned> {
    return this.inStoreTenant(storeId, () => this.presign(input));
  }

  async confirmForStore(storeId: string, mediaId: string): Promise<EvidenceStatus> {
    return this.inStoreTenant(storeId, () => this.confirm(mediaId));
  }

  async statusForStore(storeId: string, mediaId: string): Promise<EvidenceStatus> {
    return this.inStoreTenant(storeId, () => this.status(mediaId));
  }

  private async presign(input: EvidencePresignInput): Promise<EvidencePresigned> {
    // A PDF licence is a document; every photo is a verification image (metadata stripped).
    const kind = input.contentType === 'application/pdf' ? 'document' : 'verification_image';
    const presigned = await this.media.presign({ ...input, kind });
    return { mediaId: presigned.id, upload: presigned.upload };
  }

  private async confirm(mediaId: string): Promise<EvidenceStatus> {
    await this.ownEvidence(mediaId);
    const status = await this.media.confirm(mediaId);
    return { mediaId, status: status.status };
  }

  private async status(mediaId: string): Promise<EvidenceStatus> {
    return { mediaId, status: (await this.ownEvidence(mediaId)) as EvidenceStatus['status'] };
  }

  private async ownEvidence(mediaId: string): Promise<string> {
    const status = await this.read((tx) => this.repo.ownEvidenceStatus(tx, mediaId));
    if (!status) throw new MediaAssetNotFoundException();
    return status;
  }

  private async inStoreTenant<T>(storeId: string, work: () => Promise<T>): Promise<T> {
    this.requireUser();
    const tenantId = await this.storeTenant(storeId);
    return this.ownership.inTenant(tenantId, 'lookup', work);
  }

  private async write<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw verificationError(sqlStateOf(error), sqlDetailOf(error)) ?? error;
    }
  }

  private async storeTenant(storeId: string): Promise<string> {
    const tenantId = await this.tenantDb.transaction(
      async (tx) => {
        const rows = await tx.execute(
          sql`select public.item_tenant_of('store', ${storeId}::uuid) as tenant_id`,
        );
        return (
          z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
          null
        );
      },
      { accessMode: 'read only' },
    );
    if (!tenantId) throw new VerificationStoreNotFoundException();
    return tenantId;
  }

  private read<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }

  private requireUser(): string {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }

  private tenantId(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}

function view(r: MineRow): MyVerification {
  return {
    id: r.verification_id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    level: r.level_code,
    status: r.status_code,
    rejectionReason: r.rejection_reason_code,
    note: r.decision_note,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

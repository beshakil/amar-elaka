import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { sqlStateOf } from '../common/utils/sql-state';
import {
  RefreshTokenExpiredException,
  RefreshTokenInvalidException,
  RefreshTokenReusedException,
} from './exceptions/auth.exceptions';
import type { DeviceInput } from './dto/device.schema';

// .nonempty() for the three functions guaranteed (by their own SQL) to
// always return exactly one row — lets TS treat `row` as always present.
const RESOLVE_OR_CREATE_ROW = z.object({
  user_id: z.string().uuid(),
  is_new: z.boolean(),
  blacklist_severity: z.string().nullable(),
});

const IDENTITY_LOOKUP_ROW = z.object({
  user_id: z.string().uuid(),
  blacklist_severity: z.string().nullable(),
});

const CREDENTIAL_ROW = z.object({
  user_id: z.string().uuid(),
  password_hash: z.string().nullable(),
  blacklist_severity: z.string().nullable(),
});

const SESSION_ROW = z.object({
  member_id: z.string().uuid(),
  role_code: z.string(),
  device_id: z.string().uuid(),
});

const ROTATE_ROW = z.object({
  user_id: z.string().uuid(),
  member_id: z.string().uuid(),
  role_code: z.string(),
  device_id: z.string().uuid(),
});

export interface ResolvedIdentity {
  userId: string;
  blacklistSeverity: string | null;
}

export interface FinalizedSession {
  memberId: string;
  roleCode: string;
  deviceId: string;
}

/**
 * Thin wrapper around the SECURITY DEFINER functions from
 * infra/migrations/0013_auth_credentials.sql — the only place raw SQL for
 * the auth module lives, so AuthService stays free of `sql` template
 * literals and Postgres error-code handling.
 */
@Injectable()
export class AuthRepository {
  async resolveOrCreateByPhone(
    tx: DatabaseTransaction,
    phone: string,
  ): Promise<ResolvedIdentity & { isNew: boolean }> {
    const rows = await tx.execute(
      sql`select * from public.auth_resolve_or_create_by_phone(${phone})`,
    );
    const [row] = z
      .array(RESOLVE_OR_CREATE_ROW)
      .nonempty()
      .parse([...rows]);
    return { userId: row.user_id, isNew: row.is_new, blacklistSeverity: row.blacklist_severity };
  }

  async getByGoogleId(
    tx: DatabaseTransaction,
    googleId: string,
  ): Promise<ResolvedIdentity | undefined> {
    const rows = await tx.execute(sql`select * from public.auth_get_by_google_id(${googleId})`);
    const [row] = z.array(IDENTITY_LOOKUP_ROW).parse([...rows]);
    return row && { userId: row.user_id, blacklistSeverity: row.blacklist_severity };
  }

  async getCredentialByEmail(
    tx: DatabaseTransaction,
    email: string,
  ): Promise<(ResolvedIdentity & { passwordHash: string | null }) | undefined> {
    const rows = await tx.execute(sql`select * from public.auth_get_credential_by_email(${email})`);
    const [row] = z.array(CREDENTIAL_ROW).parse([...rows]);
    return (
      row && {
        userId: row.user_id,
        passwordHash: row.password_hash,
        blacklistSeverity: row.blacklist_severity,
      }
    );
  }

  async finalizeSession(
    tx: DatabaseTransaction,
    params: {
      userId: string;
      tenantId: string;
      device: DeviceInput;
      tokenHash: string;
      familyId: string;
      expiresAt: Date;
      createdIp: string | undefined;
      userAgent: string | undefined;
    },
  ): Promise<FinalizedSession> {
    const rows = await tx.execute(sql`
      select * from public.auth_finalize_session(
        ${params.userId}, ${params.tenantId}, ${JSON.stringify(params.device)}::jsonb,
        ${params.tokenHash}, ${params.familyId}, ${params.expiresAt.toISOString()}::timestamptz,
        ${params.createdIp ?? null}::inet, ${params.userAgent ?? null}
      )
    `);
    const [row] = z
      .array(SESSION_ROW)
      .nonempty()
      .parse([...rows]);
    return { memberId: row.member_id, roleCode: row.role_code, deviceId: row.device_id };
  }

  async rotateRefreshToken(
    tx: DatabaseTransaction,
    params: {
      oldTokenHash: string;
      newTokenHash: string;
      newExpiresAt: Date;
      tenantId: string;
      createdIp: string | undefined;
      userAgent: string | undefined;
    },
  ): Promise<{ userId: string; memberId: string; roleCode: string; deviceId: string }> {
    try {
      const rows = await tx.execute(sql`
        select * from public.auth_rotate_refresh_token(
          ${params.oldTokenHash}, ${params.newTokenHash}, ${params.newExpiresAt.toISOString()}::timestamptz,
          ${params.tenantId}, ${params.createdIp ?? null}::inet, ${params.userAgent ?? null}
        )
      `);
      const [row] = z
        .array(ROTATE_ROW)
        .nonempty()
        .parse([...rows]);
      return {
        userId: row.user_id,
        memberId: row.member_id,
        roleCode: row.role_code,
        deviceId: row.device_id,
      };
    } catch (error) {
      const sqlState = sqlStateOf(error);
      if (sqlState === 'AE001') throw new RefreshTokenInvalidException();
      if (sqlState === 'AE002') throw new RefreshTokenReusedException();
      if (sqlState === 'AE003') throw new RefreshTokenExpiredException();
      throw error;
    }
  }
}

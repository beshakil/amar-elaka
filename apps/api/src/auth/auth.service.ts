import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { sqlStateOf } from '../common/utils/sql-state';
import type { DatabaseTransaction } from '../database/database.client';
import { authRefreshTokens, userProfiles, users } from '../database/schema/identity';
import { TenantContext, type AppRole } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import { AuthRepository } from './auth.repository';
import type { DeviceInput } from './dto/device.schema';
import {
  AccountBannedException,
  AccountRestrictedException,
  AccountTerminatedException,
  DisplayNameTooLongException,
  EmailAlreadyRegisteredException,
  GoogleAccountAlreadyLinkedException,
  GoogleAccountNotLinkedException,
  InvalidCredentialsException,
  RefreshTokenReusedException,
  TenantRequiredException,
  UnauthenticatedException,
  WeakPasswordException,
} from './exceptions/auth.exceptions';
import { GoogleTokenVerifierService } from './google/google-token-verifier.service';
import { OtpService, type OtpSent } from './otp/otp.service';
import { PasswordService } from './password/password.service';
import { TokenService } from './tokens/token.service';
import type { MeResult, SessionTokens } from './dto/auth-responses.dto';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class AuthService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
    private readonly repo: AuthRepository,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly password: PasswordService,
    private readonly google: GoogleTokenVerifierService,
    private readonly settings: SettingsService,
  ) {}

  requestOtp(phone: string, ip: string): Promise<OtpSent> {
    return this.otp.requestOtp(phone, ip);
  }

  async verifyOtpAndLogin(
    phone: string,
    code: string,
    device: DeviceInput,
    ip: string,
    userAgent: string | undefined,
  ): Promise<SessionTokens> {
    // Checked before verifyOtp (which is single-use) so a missing tenant
    // doesn't burn the caller's OTP on a request that was doomed anyway.
    const tenantId = this.requireTenantId();
    await this.otp.verifyOtp(phone, code);

    return this.tenantDb.transaction(async (tx) => {
      const identity = await this.repo.resolveOrCreateByPhone(tx, phone);
      this.assertNotBlacklisted(identity.blacklistSeverity);
      return this.finalizeAndSign(tx, identity.userId, tenantId, device, ip, userAgent);
    });
  }

  /**
   * Dual-mode: with an authenticated caller (TenantContext already has a
   * userId — populated by OptionalJwtAuthGuard from a valid Bearer token),
   * this links the Google identity to the caller's own account instead of
   * logging in. See auth module plan: Google can never create an account by
   * itself, only phone can.
   */
  async googleAuth(
    idToken: string,
    device: DeviceInput,
    ip: string,
    userAgent: string | undefined,
  ): Promise<SessionTokens | { linked: true }> {
    const identity = await this.google.verify(idToken);
    const currentUserId = this.tenantContext.current()?.userId;

    if (currentUserId) {
      await this.tenantDb.transaction(async (tx) => {
        try {
          if (!(await this.repo.linkGoogle(tx, identity.googleId))) {
            throw new UnauthenticatedException();
          }
        } catch (error) {
          if (sqlStateOf(error) === UNIQUE_VIOLATION)
            throw new GoogleAccountAlreadyLinkedException();
          throw error;
        }
      });
      return { linked: true };
    }

    const tenantId = this.requireTenantId();
    return this.tenantDb.transaction(async (tx) => {
      const found = await this.repo.getByGoogleId(tx, identity.googleId);
      if (!found) throw new GoogleAccountNotLinkedException();
      this.assertNotBlacklisted(found.blacklistSeverity);
      return this.finalizeAndSign(tx, found.userId, tenantId, device, ip, userAgent);
    });
  }

  async registerEmailPassword(email: string, password: string): Promise<void> {
    const userId = this.tenantContext.require().userId;
    if (!userId) throw new TenantRequiredException();

    const minLength = await this.settings.get('auth_password_min_length');
    if (password.length < minLength) {
      throw new WeakPasswordException(minLength);
    }

    const passwordHash = await this.password.hash(password);
    await this.tenantDb.transaction(async (tx) => {
      try {
        if (!(await this.repo.setEmailCredential(tx, email, passwordHash))) {
          throw new UnauthenticatedException();
        }
      } catch (error) {
        if (sqlStateOf(error) === UNIQUE_VIOLATION) throw new EmailAlreadyRegisteredException();
        throw error;
      }
    });
  }

  async emailLogin(
    email: string,
    password: string,
    device: DeviceInput,
    ip: string,
    userAgent: string | undefined,
  ): Promise<SessionTokens> {
    const tenantId = this.requireTenantId();

    return this.tenantDb.transaction(async (tx) => {
      const credential = await this.repo.getCredentialByEmail(tx, email);
      const ok = await this.password.verify(credential?.passwordHash, password);
      if (!ok || !credential) {
        throw new InvalidCredentialsException();
      }
      this.assertNotBlacklisted(credential.blacklistSeverity);
      return this.finalizeAndSign(tx, credential.userId, tenantId, device, ip, userAgent);
    });
  }

  async refresh(
    refreshToken: string,
    ip: string,
    userAgent: string | undefined,
  ): Promise<SessionTokens> {
    const tenantId = this.requireTenantId();
    const oldTokenHash = this.tokens.hashRefreshToken(refreshToken);
    const next = this.tokens.generateOpaqueToken();
    const newExpiresAt = this.tokens.refreshTokenExpiresAt();

    const rotated = await this.tenantDb.transaction((tx) =>
      this.repo.rotateRefreshToken(tx, {
        oldTokenHash,
        newTokenHash: next.tokenHash,
        newExpiresAt,
        tenantId,
        createdIp: ip,
        userAgent,
      }),
    );
    // Thrown only after the transaction committed: on reuse the database has
    // just revoked the whole token family, and throwing inside would undo it.
    if (rotated.kind === 'reused') throw new RefreshTokenReusedException();

    const accessToken = await this.tokens.signAccessToken({
      userId: rotated.userId,
      tenantId,
      memberId: rotated.memberId,
      role: rotated.roleCode as AppRole,
    });
    return { accessToken, refreshToken: next.token };
  }

  async logout(refreshToken: string): Promise<void> {
    const userId = this.tenantContext.require().userId;
    if (!userId) throw new TenantRequiredException();
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);

    await this.tenantDb.transaction(async (tx) => {
      const [row] = await tx
        .select({ familyId: authRefreshTokens.familyId })
        .from(authRefreshTokens)
        .where(
          and(eq(authRefreshTokens.tokenHash, tokenHash), eq(authRefreshTokens.userId, userId)),
        )
        .limit(1);
      if (!row) return;

      await tx
        .update(authRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(authRefreshTokens.familyId, row.familyId), isNull(authRefreshTokens.revokedAt)),
        );
    });
  }

  async logoutAll(): Promise<void> {
    const userId = this.tenantContext.require().userId;
    if (!userId) throw new TenantRequiredException();

    await this.tenantDb.transaction((tx) =>
      tx
        .update(authRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(authRefreshTokens.userId, userId), isNull(authRefreshTokens.revokedAt))),
    );
  }

  async me(): Promise<MeResult> {
    const { userId, tenantId, memberId, role } = this.tenantContext.require();
    if (!userId || !tenantId || !memberId || !role) {
      throw new TenantRequiredException();
    }

    return this.tenantDb.transaction(async (tx) => {
      const [row] = await tx
        .select({
          phone: users.phoneE164,
          email: users.email,
          displayName: userProfiles.displayName,
          avatarStorageKey: userProfiles.avatarStorageKey,
        })
        .from(users)
        .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(eq(users.id, userId))
        .limit(1);
      // The access token was valid, so this row existing is an invariant, not a client-facing case.
      if (!row)
        throw new Error(`auth: user ${userId} not found for a validly-authenticated request`);

      return {
        userId,
        phone: row.phone,
        email: row.email,
        displayName: row.displayName,
        avatarStorageKey: row.avatarStorageKey,
        tenantId,
        memberId,
        role,
      };
    });
  }

  /** Profile completion / edit — `userProfiles` is guaranteed to exist for any authenticated caller (see `me()`). */
  async updateProfile(input: {
    displayName?: string | undefined;
    avatarStorageKey?: string | null | undefined;
  }): Promise<MeResult> {
    const userId = this.tenantContext.require().userId;
    if (!userId) throw new TenantRequiredException();

    if (input.displayName === undefined && input.avatarStorageKey === undefined) {
      return this.me();
    }

    if (input.displayName !== undefined) {
      const maxLength = await this.settings.get('profile_display_name_max_length');
      if (input.displayName.length > maxLength) {
        throw new DisplayNameTooLongException(maxLength);
      }
    }

    await this.tenantDb.transaction((tx) =>
      tx
        .update(userProfiles)
        .set({
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.avatarStorageKey !== undefined
            ? { avatarStorageKey: input.avatarStorageKey }
            : {}),
        })
        .where(eq(userProfiles.userId, userId)),
    );

    return this.me();
  }

  private async finalizeAndSign(
    tx: DatabaseTransaction,
    userId: string,
    tenantId: string,
    device: DeviceInput,
    ip: string,
    userAgent: string | undefined,
  ): Promise<SessionTokens> {
    const issued = this.tokens.issueRefreshToken();
    const session = await this.repo.finalizeSession(tx, {
      userId,
      tenantId,
      device,
      tokenHash: issued.tokenHash,
      familyId: issued.familyId,
      expiresAt: issued.expiresAt,
      createdIp: ip,
      userAgent,
    });
    const accessToken = await this.tokens.signAccessToken({
      userId,
      tenantId,
      memberId: session.memberId,
      role: session.roleCode as AppRole,
    });
    return { accessToken, refreshToken: issued.token };
  }

  private assertNotBlacklisted(severity: string | null): void {
    if (severity === 'terminated') throw new AccountTerminatedException();
    if (severity === 'banned') throw new AccountBannedException();
    if (severity === 'restricted') throw new AccountRestrictedException();
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.current()?.tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}

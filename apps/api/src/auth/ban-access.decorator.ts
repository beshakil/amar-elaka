import { SetMetadata } from '@nestjs/common';

/** Route metadata read by JwtAuthGuard / OptionalJwtAuthGuard (ADR 063, schema.md §9.10). */
export const BAN_ACCESS_KEY = 'banAccess';
export type BanAccess = 'appeal' | 'active';

/**
 * On the allow-list of a banned session: the account, its bans and appeals,
 * logout and refresh. Every other route answers 403 ACCOUNT_BANNED.
 */
export const AppealAllowed = (): MethodDecorator & ClassDecorator =>
  SetMetadata(BAN_ACCESS_KEY, 'appeal');

/** Posting, chatting and reviewing: refused to a restricted account (403 ACCOUNT_RESTRICTED). */
export const ActiveAccountRequired = (): MethodDecorator & ClassDecorator =>
  SetMetadata(BAN_ACCESS_KEY, 'active');

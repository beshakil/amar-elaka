import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OwnershipGuard } from './ownership.guard';
import { REQUIRE_OWNERSHIP_KEY, type OwnershipSpec } from './ownership.metadata';

/**
 * Generic row-ownership check, reusable across every table instead of a
 * manual `if (post.authorMemberId !== memberId)` in each controller —
 * e.g. `@RequireOwnership({ table: 'posts', ownerColumn: 'author_member_id', idParam: 'id' })`.
 * Combine with `@RequirePermission()` for the "can act on this kind of
 * thing at all" check; this only narrows to "and specifically this row".
 */
export const RequireOwnership = (spec: OwnershipSpec): ReturnType<typeof applyDecorators> =>
  applyDecorators(
    SetMetadata(REQUIRE_OWNERSHIP_KEY, spec),
    UseGuards(JwtAuthGuard, OwnershipGuard),
  );

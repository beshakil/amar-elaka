import type { PostStatus } from './post-state-machine';

/**
 * Who is looking at a post. `staff` mirrors the database's app_is_staff()
 * (moderator, tenant_admin, partner_owner) in the post's owning tenant, plus
 * platform staff; the RLS policies already limit staff to their own tenant.
 * `manager` is the owner or a manager of the post's store (ADR 057): they
 * see it as its author does, without it being theirs.
 */
export type PostViewer = 'owner' | 'manager' | 'staff' | 'public';

export interface VisibilityFacts {
  status: PostStatus;
  hiddenByOwner: boolean;
  deleted: boolean;
  scrubbed: boolean;
}

/**
 * GET /posts/:id visibility:
 *   live, sold          public (sold is shown marked sold; the feed skips it)
 *   everything else     owner and staff only
 *   hidden or deleted   owner and staff only
 *   scrubbed            whoever may see it gets the scrubbed shape only
 *
 * `none` is answered as 404, never 403, so a hidden post's existence doesn't leak.
 */
export function visibilityOf(
  post: VisibilityFacts,
  viewer: PostViewer,
): 'full' | 'scrubbed' | 'none' {
  const visible =
    viewer !== 'public' ||
    ((post.status === 'live' || post.status === 'sold') && !post.hiddenByOwner && !post.deleted);
  if (!visible) return 'none';
  return post.scrubbed ? 'scrubbed' : 'full';
}

const STAFF_ROLES: ReadonlySet<string> = new Set([
  'moderator',
  'tenant_admin',
  'partner_owner',
  'platform_admin',
  'platform_support',
]);

export function isStaffRole(role: string | undefined): boolean {
  return role !== undefined && STAFF_ROLES.has(role);
}

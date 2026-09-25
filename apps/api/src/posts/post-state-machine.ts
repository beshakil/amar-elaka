import { IllegalPostTransitionException } from './posts.exceptions';

/**
 * The one place post status transitions are decided (ADR 005, schema.md
 * §4.2). Every status change in the posts module goes through
 * assertTransition(); nothing else writes `status_code`.
 *
 * Soft delete (`deleted_at` + `deletion_reason_code`) and the owner's
 * `hidden_by_owner` are deliberately NOT statuses — they sit beside the
 * machine and never change `status_code`.
 */

export const POST_STATUSES = [
  'draft',
  'pending',
  'live',
  'rejected',
  'sold',
  'expired',
  'removed',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/**
 * owner     — the post's author, through /posts endpoints
 * moderator — tenant staff, through the moderation queue
 * system    — the platform itself: auto-publish in post-moderated tenants,
 *             the expiry sweep
 */
export type PostActor = 'owner' | 'moderator' | 'system';

const TRANSITIONS: Readonly<
  Record<PostStatus, Readonly<Partial<Record<PostStatus, readonly PostActor[]>>>>
> = {
  draft: { pending: ['owner'] },
  pending: { live: ['moderator', 'system'], rejected: ['moderator'] },
  // Owner edits a rejected/removed post, then resubmits it.
  rejected: { pending: ['owner'] },
  removed: { pending: ['owner'] },
  live: {
    sold: ['owner'],
    expired: ['system'],
    removed: ['moderator'],
    // The owner only edits; the SYSTEM decides the edit needs re-review
    // (post_rereview_fields, pre-moderated tenant) and sends it back. The
    // owner can't move a live post to pending directly (e.g. via submit).
    pending: ['system'],
  },
  expired: { live: ['owner'] }, // repost
  sold: {},
};

export function canTransition(from: PostStatus, to: PostStatus, actor: PostActor): boolean {
  return TRANSITIONS[from][to]?.includes(actor) ?? false;
}

/** Throws IllegalPostTransitionException (409) unless `actor` may move a post `from` → `to`. */
export function assertTransition(from: PostStatus, to: PostStatus, actor: PostActor): void {
  if (!canTransition(from, to, actor)) throw new IllegalPostTransitionException(from, to, actor);
}

export function isPostStatus(value: string): value is PostStatus {
  return (POST_STATUSES as readonly string[]).includes(value);
}

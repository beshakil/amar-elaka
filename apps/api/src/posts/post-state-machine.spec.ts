import {
  assertTransition,
  canTransition,
  POST_STATUSES,
  type PostActor,
  type PostStatus,
} from './post-state-machine';
import { IllegalPostTransitionException } from './posts.exceptions';

// The contract, written out independently of the implementation's table:
//   draft -> pending -> live; pending -> rejected -> (owner edits) -> pending
//   live -> sold | expired | removed; expired -> live (repost)
//   removed -> pending (owner edits and resubmits)
//   live -> pending: the system, after an owner's edit to a re-review field
//                    in a pre-moderated tenant (never the owner directly)
const LEGAL: readonly [PostStatus, PostStatus, PostActor][] = [
  ['draft', 'pending', 'owner'],
  ['pending', 'live', 'moderator'],
  ['pending', 'live', 'system'],
  ['pending', 'rejected', 'moderator'],
  ['rejected', 'pending', 'owner'],
  ['live', 'sold', 'owner'],
  ['live', 'expired', 'system'],
  ['live', 'removed', 'moderator'],
  ['live', 'pending', 'system'],
  ['expired', 'live', 'owner'],
  ['removed', 'pending', 'owner'],
];
const ACTORS: readonly PostActor[] = ['owner', 'moderator', 'system'];

const isLegal = (from: PostStatus, to: PostStatus, actor: PostActor) =>
  LEGAL.some(([f, t, a]) => f === from && t === to && a === actor);

const ALL = POST_STATUSES.flatMap((from) =>
  POST_STATUSES.flatMap((to) => ACTORS.map((actor) => [from, to, actor] as const)),
);

describe('post state machine', () => {
  it.each(LEGAL)('allows %s → %s by %s', (from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(true);
    expect(() => assertTransition(from, to, actor)).not.toThrow();
  });

  it.each(ALL.filter(([from, to, actor]) => !isLegal(from, to, actor)))(
    'rejects %s → %s by %s with a typed 409',
    (from, to, actor) => {
      expect(canTransition(from, to, actor)).toBe(false);
      let caught: unknown;
      try {
        assertTransition(from, to, actor);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IllegalPostTransitionException);
      expect(caught).toMatchObject({ httpStatus: 409, issues: { from, to, actor } });
    },
  );

  it('covers every (from, to, actor) combination', () => {
    expect(ALL).toHaveLength(POST_STATUSES.length * POST_STATUSES.length * ACTORS.length);
  });

  it('has no way out of sold, and never a same-status "transition"', () => {
    for (const to of POST_STATUSES) {
      for (const actor of ACTORS) expect(canTransition('sold', to, actor)).toBe(false);
    }
    for (const status of POST_STATUSES) {
      for (const actor of ACTORS) expect(canTransition(status, status, actor)).toBe(false);
    }
  });
});

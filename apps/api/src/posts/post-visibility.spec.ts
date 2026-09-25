import { POST_STATUSES } from './post-state-machine';
import {
  isStaffRole,
  visibilityOf,
  type PostViewer,
  type VisibilityFacts,
} from './post-visibility';

const VIEWERS: readonly PostViewer[] = ['owner', 'staff', 'public'];
const plain = (status: VisibilityFacts['status']): VisibilityFacts => ({
  status,
  hiddenByOwner: false,
  deleted: false,
  scrubbed: false,
});

describe('post visibility (GET /posts/:id)', () => {
  it.each(POST_STATUSES.flatMap((status) => VIEWERS.map((viewer) => [status, viewer] as const)))(
    '%s as %s',
    (status, viewer) => {
      const publicStatus = status === 'live' || status === 'sold';
      const expected = viewer === 'public' && !publicStatus ? 'none' : 'full';
      expect(visibilityOf(plain(status), viewer)).toBe(expected);
    },
  );

  it.each(['hiddenByOwner', 'deleted'] as const)(
    'a %s live post is for owner and staff only',
    (flag) => {
      const post = { ...plain('live'), [flag]: true };
      expect(visibilityOf(post, 'owner')).toBe('full');
      expect(visibilityOf(post, 'staff')).toBe('full');
      expect(visibilityOf(post, 'public')).toBe('none');
    },
  );

  it('shows a scrubbed post only in its scrubbed shape, to whoever may see it', () => {
    const soldScrubbed = { ...plain('sold'), scrubbed: true };
    expect(visibilityOf(soldScrubbed, 'public')).toBe('scrubbed');
    expect(visibilityOf(soldScrubbed, 'owner')).toBe('scrubbed');

    const removedScrubbed = { ...plain('removed'), scrubbed: true, deleted: true };
    expect(visibilityOf(removedScrubbed, 'public')).toBe('none');
    expect(visibilityOf(removedScrubbed, 'staff')).toBe('scrubbed');
  });

  it('treats the same roles as staff as the database does (app_is_staff) plus platform staff', () => {
    for (const role of [
      'moderator',
      'tenant_admin',
      'partner_owner',
      'platform_admin',
      'platform_support',
    ]) {
      expect(isStaffRole(role)).toBe(true);
    }
    for (const role of ['member', 'agent', 'seller', 'anon', undefined])
      expect(isStaffRole(role)).toBe(false);
  });
});

import type { MyPostCounts, Post } from '../api/schemas';

/** The "my posts" tabs (as on mobile). Status tabs leave hidden posts out; hidden has its own. */
export const MY_POSTS_TABS = ['live', 'pending', 'sold', 'expired', 'rejected', 'hidden'] as const;
export type MyPostsTab = (typeof MY_POSTS_TABS)[number];

export function isMyPostsTab(value: string | undefined): value is MyPostsTab {
  return value !== undefined && (MY_POSTS_TABS as readonly string[]).includes(value);
}

/** GET /posts/me's query for a tab. */
export function tabQuery(tab: MyPostsTab): Record<string, string> {
  if (tab === 'hidden') return { hidden: 'true' };
  const status = tab === 'rejected' ? 'rejected,removed' : tab;
  return { status, hidden: 'false' };
}

export function tabCount(tab: MyPostsTab, counts: MyPostCounts): number {
  return tab === 'rejected' ? counts.rejected + counts.removed : counts[tab];
}

export type PostAction =
  'edit' | 'markSold' | 'renew' | 'repost' | 'resubmit' | 'hide' | 'unhide' | 'delete';

/**
 * What a seller may do with a post in this state (the API decides for real;
 * this only avoids offering what it would refuse). Sold posts are sales
 * history: never deleted, only hidden.
 */
export function actionsFor(post: Pick<Post, 'status' | 'hiddenByOwner'>): PostAction[] {
  if (post.hiddenByOwner)
    return ['unhide', ...(post.status === 'sold' ? [] : (['delete'] as const))];
  switch (post.status) {
    case 'live':
      return ['edit', 'markSold', 'renew', 'hide', 'delete'];
    case 'pending':
      return ['edit', 'delete'];
    case 'expired':
      return ['repost', 'edit', 'delete'];
    case 'sold':
      return ['hide'];
    case 'rejected':
    case 'removed':
      return ['resubmit', 'delete'];
    case 'draft':
      return ['edit', 'delete'];
  }
}

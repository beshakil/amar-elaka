import { cache } from 'react';
import { ApiError } from '../api/errors';
import { apiFetch } from '../api/fetch';
import { postDetailSchema, shortLinkSchema, type PostDetail, type ShortLink } from '../api/schemas';
import { currentTenantId } from '../tenant';

/**
 * A share link's post (ADR 036): the code, then the post's detail as a
 * visitor sees it. Null when the code doesn't exist or the post is no longer
 * public. Cached per request, so the page and its metadata share one fetch.
 */
export const loadSharedPost = cache(
  async (code: string): Promise<{ link: ShortLink; post: PostDetail } | null> => {
    const tenantId = (await currentTenantId()) ?? undefined;
    try {
      const link = await apiFetch({
        path: `/s/${encodeURIComponent(code)}`,
        schema: shortLinkSchema,
        tenantId,
      });
      const post = await apiFetch({
        path: `/posts/${link.postId}/detail`,
        schema: postDetailSchema,
        tenantId,
      });
      return { link, post };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
);

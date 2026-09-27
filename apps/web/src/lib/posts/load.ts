import { z } from 'zod';
import { apiFetch } from '../api/fetch';
import {
  catalogCategorySchema,
  myPostCountsSchema,
  myPostsSchema,
  postSchema,
  type CatalogCategory,
  type MyPostCounts,
  type MyPostsPage,
  type Post,
} from '../api/schemas';
import type { Viewer } from '../auth/viewer';
import { tabQuery, type MyPostsTab } from './my-posts';

const auth = (viewer: Viewer) => ({
  tenantId: viewer.tenantId,
  accessToken: viewer.session.accessToken,
});

/** The categories this area takes posts in (GET /categories, minus module tiles). */
export async function postableCategories(viewer: Viewer): Promise<CatalogCategory[]> {
  const all = await apiFetch({
    path: '/categories',
    schema: z.array(catalogCategorySchema),
    ...auth(viewer),
  });
  return all.filter((category) => category.fieldSchema !== null);
}

export function myPost(viewer: Viewer, id: string): Promise<Post> {
  return apiFetch({ path: `/posts/${id}`, schema: postSchema, ...auth(viewer) });
}

export function myPosts(
  viewer: Viewer,
  tab: MyPostsTab,
  cursor: string | undefined,
): Promise<MyPostsPage> {
  return apiFetch({
    path: '/posts/me',
    schema: myPostsSchema,
    ...auth(viewer),
    query: { ...tabQuery(tab), ...(cursor ? { cursor } : {}) },
  });
}

export function myPostCounts(viewer: Viewer): Promise<MyPostCounts> {
  return apiFetch({ path: '/posts/me/counts', schema: myPostCountsSchema, ...auth(viewer) });
}

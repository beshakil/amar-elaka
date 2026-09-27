import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { NoCoverage } from '@/components/no-coverage';
import { pickMessages } from '@/lib/i18n-messages';
import { ApiError } from '@/lib/api/errors';
import { requireViewer } from '@/lib/auth/viewer';
import { myPost, postableCategories } from '@/lib/posts/load';
import { currentTenantConfig } from '@/lib/tenant';
import { editorTenant } from '../../../../post/editor-tenant';
import { PostEditor } from '../../../../post/post-editor';

export const metadata: Metadata = { robots: { index: false, follow: false } };

// A nested provider replaces the layout's messages rather than adding to
// them, so the shared form and photo uploader namespaces come along too.
const EDITOR_NAMESPACES = ['postEditor', 'postErrors', 'myPosts', 'dynamicForm', 'mediaUploader'];

/** Edit a post, or fix a rejected one and send it back for review. */
export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, viewer] = await Promise.all([params, requireViewer()]);
  const post = await myPost(viewer, id).catch((error: unknown) => {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  const [tenant, categories, messages] = await Promise.all([
    currentTenantConfig(),
    postableCategories(viewer),
    getMessages(),
  ]);
  if (!tenant) return <NoCoverage />;
  return (
    <NextIntlClientProvider messages={pickMessages(messages, EDITOR_NAMESPACES)}>
      <PostEditor
        mode={{ kind: 'edit', post }}
        categories={categories}
        me={{ displayName: viewer.me.displayName, phone: viewer.me.phone }}
        tenant={editorTenant(tenant)}
      />
    </NextIntlClientProvider>
  );
}

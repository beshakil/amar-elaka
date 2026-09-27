import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { NoCoverage } from '@/components/no-coverage';
import { pickMessages } from '@/lib/i18n-messages';
import { requireViewer } from '@/lib/auth/viewer';
import { postableCategories } from '@/lib/posts/load';
import { currentTenantConfig } from '@/lib/tenant';
import { editorTenant } from '../editor-tenant';
import { PostEditor } from '../post-editor';

export const metadata: Metadata = { robots: { index: false, follow: false } };

// A nested provider replaces the layout's messages rather than adding to
// them, so the shared form and photo uploader namespaces come along too.
const EDITOR_NAMESPACES = ['postEditor', 'postErrors', 'myPosts', 'dynamicForm', 'mediaUploader'];

/** New post (signed-in sellers; middleware sends others to /login and back). */
export default async function NewPostPage() {
  const viewer = await requireViewer();
  const [tenant, categories, messages] = await Promise.all([
    currentTenantConfig(),
    postableCategories(viewer),
    getMessages(),
  ]);
  if (!tenant) return <NoCoverage />;
  return (
    <NextIntlClientProvider messages={pickMessages(messages, EDITOR_NAMESPACES)}>
      <PostEditor
        mode={{ kind: 'create' }}
        categories={categories}
        me={{ displayName: viewer.me.displayName, phone: viewer.me.phone }}
        tenant={editorTenant(tenant)}
      />
    </NextIntlClientProvider>
  );
}

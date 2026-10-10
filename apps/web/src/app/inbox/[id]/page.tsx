import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { z } from 'zod';
import { ConversationView } from '@/components/chat/conversation-view';
import { requireViewer } from '@/lib/auth/viewer';
import { chatThread } from '@/lib/chat/load';
import { pickMessages } from '@/lib/i18n-messages';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** /inbox/<id>: one conversation (ADR 060) — loaded here, then live in the browser. */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const viewer = await requireViewer();
  const [thread, messages] = await Promise.all([chatThread(viewer, id), getMessages()]);
  return (
    <NextIntlClientProvider messages={pickMessages(messages, ['chat', 'notifications'])}>
      <ConversationView
        initialConversation={thread.conversation}
        // The API pages newest first; the thread reads top to bottom.
        initialMessages={[...thread.history.items].reverse()}
        initialHasOlder={thread.history.hasMore}
        quickReplies={thread.quickReplies}
        offerPush
      />
    </NextIntlClientProvider>
  );
}

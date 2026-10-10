import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { requireViewer } from '@/lib/auth/viewer';
import { openForPost } from '@/lib/chat/load';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * "মেসেজ দিন" on a listing lands here (`?post=<id>`): sign-in first if needed
 * (middleware.ts, back here after), then the conversation for this buyer and
 * post — opened, or the one they already have — and straight into it.
 */
export default async function OpenConversation({
  searchParams,
}: {
  searchParams: Promise<{ post?: string }>;
}) {
  const { post } = await searchParams;
  if (!z.string().uuid().safeParse(post).success) notFound();
  const viewer = await requireViewer();
  let target: string | null = null;
  let code: string | null = null;
  try {
    target = (await openForPost(viewer, post!)).id;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    code = error.code;
  }
  if (target) redirect(`/inbox/${target}` as Route);

  const t = await getTranslations('chat');
  return (
    <section className="mx-auto max-w-md space-y-4 text-center">
      <p>{code === 'CHAT_OWN_LISTING' ? t('ownPost') : t('openFailed')}</p>
      <Link href={`/listing/${post}` as Route} className="text-brand hover:underline">
        {t('viewPost')}
      </Link>
    </section>
  );
}

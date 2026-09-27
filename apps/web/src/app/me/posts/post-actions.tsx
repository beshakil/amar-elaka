'use client';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { parseMoneyInput } from '@amar-elaka/dynamic-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PostStatus } from '@/lib/api/schemas';
import { deletePost, markSold, repost, setHidden, type ActionResult } from '@/lib/posts/actions';
import { postErrorMessage } from '@/lib/posts/errors';
import { actionsFor, type PostAction } from '@/lib/posts/my-posts';

type Pending = 'markSold' | 'delete' | null;

/**
 * The buttons a post's state allows, as on the app. Delete and "sold" ask
 * first; every outcome is said in one line — done, or exactly why not — and
 * the list is refetched so the post lands in its new tab.
 */
export function PostActions({
  post,
}: {
  post: { id: string; status: PostStatus; hiddenByOwner: boolean };
}) {
  const t = useTranslations('myPosts');
  const tErr = useTranslations('postErrors');
  const format = useFormatter();
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<Pending>(null);
  const [soldPrice, setSoldPrice] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function run(action: PostAction, call: () => Promise<ActionResult<unknown>>) {
    startTransition(async () => {
      let result: ActionResult<unknown>;
      try {
        result = await call();
      } catch {
        result = { ok: false, error: { code: 'NETWORK' } };
      }
      if (result.ok) {
        setConfirming(null);
        setMessage({ text: t(`done.${action as 'markSold'}`), error: false });
        router.refresh();
      } else {
        const described = postErrorMessage(result.error, (iso) =>
          format.dateTime(new Date(iso), { day: 'numeric', month: 'long' }),
        );
        setMessage({ text: tErr(described.key, described.values), error: true });
      }
    });
  }

  function confirmSold() {
    const typed = soldPrice.trim();
    const money = typed ? parseMoneyInput(typed) : null;
    if (typed && !money) {
      setMessage({ text: t('soldPriceInvalid'), error: true });
      return;
    }
    run('markSold', () => markSold(post.id, money ?? null));
  }

  const button = (action: PostAction) => {
    switch (action) {
      case 'edit':
      case 'resubmit':
        return (
          // A full load into the editor (seller pages render afresh with the session).
          <Button key={action} asChild size="sm" variant="outline">
            <a href={`/me/posts/${post.id}/edit`}>{t(`actions.${action}`)}</a>
          </Button>
        );
      case 'markSold':
      case 'delete':
        return (
          <Button
            key={action}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setConfirming(action)}
          >
            {t(`actions.${action}`)}
          </Button>
        );
      case 'renew':
      case 'repost':
        return (
          <Button
            key={action}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(action, () => repost(post.id))}
          >
            {t(`actions.${action}`)}
          </Button>
        );
      case 'hide':
      case 'unhide':
        return (
          <Button
            key={action}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(action, () => setHidden(post.id, action === 'hide'))}
          >
            {t(`actions.${action}`)}
          </Button>
        );
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">{actionsFor(post).map(button)}</div>
      {confirming === 'delete' && (
        <div
          role="alertdialog"
          aria-label={t('deleteConfirm')}
          className="space-y-2 rounded-md border border-border p-3"
        >
          <p>{t('deleteConfirm')}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => run('delete', () => deletePost(post.id))}
            >
              {t('confirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
      {confirming === 'markSold' && (
        <form
          className="space-y-2 rounded-md border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            confirmSold();
          }}
        >
          <label className="block space-y-1">
            <span>{t('soldPriceLabel')}</span>
            <Input
              inputMode="decimal"
              value={soldPrice}
              onChange={(event) => setSoldPrice(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={busy}>
              {t('confirm')}
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setConfirming(null)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {message && (
        <p
          role={message.error ? 'alert' : 'status'}
          className={message.error ? 'text-destructive' : 'text-muted-foreground'}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

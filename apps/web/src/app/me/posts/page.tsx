import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getFormatter, getMessages, getTranslations } from 'next-intl/server';
import { formatMoney, localizeDigits, type CategoryFieldSchema } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import { pickMessages } from '@/lib/i18n-messages';
import { PostCard } from '@/components/posts/post-card';
import { Button } from '@/components/ui/button';
import { requireViewer } from '@/lib/auth/viewer';
import { cardFacts } from '@/lib/posts/display';
import { moderationReasonKey } from '@/lib/posts/errors';
import { myPostCounts, myPosts, postableCategories } from '@/lib/posts/load';
import { MY_POSTS_TABS, isMyPostsTab, tabCount, type MyPostsTab } from '@/lib/posts/my-posts';
import { currentTenantConfig } from '@/lib/tenant';
import { cn } from '@/lib/utils';
import { PostActions } from './post-actions';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * My posts: a tab per status (and hidden), each with its count, the actions
 * each state allows, and why a rejected/removed post was taken down.
 */
export default async function MyPostsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; cursor?: string }>;
}) {
  const [viewer, query] = await Promise.all([requireViewer(), searchParams]);
  const tab: MyPostsTab = isMyPostsTab(query.tab) ? query.tab : 'live';
  const [tenant, counts, page, categories, t, tEditor, tReason, format, messages] =
    await Promise.all([
      currentTenantConfig(),
      myPostCounts(viewer),
      myPosts(viewer, tab, query.cursor),
      postableCategories(viewer),
      getTranslations('myPosts'),
      getTranslations('postEditor'),
      getTranslations('moderationReasons'),
      getFormatter(),
      getMessages(),
    ]);
  if (!tenant) return <NoCoverage />;
  const schemas = new Map(
    categories.map((c) => [c.id, c.fieldSchema as CategoryFieldSchema | null]),
  );
  const date = (iso: string) =>
    localizeDigits(format.dateTime(new Date(iso), { day: 'numeric', month: 'long' }), 'bn');

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Button asChild>
          <a href="/post/new">{t('newPost')}</a>
        </Button>
      </div>

      {/* Plain links, not <Link>: a tab is a fresh server render of the list
          and every count (a soft navigation between ?tab= values of this
          page didn't land in production builds). */}
      <nav aria-label={t('title')} className="flex flex-wrap gap-2">
        {MY_POSTS_TABS.map((key) => (
          <a
            key={key}
            href={`/me/posts?tab=${key}`}
            aria-current={key === tab ? 'page' : undefined}
            className={cn(
              'rounded-full border px-3 py-1 text-sm',
              key === tab
                ? 'border-brand bg-brand text-brand-foreground'
                : 'border-border hover:bg-muted',
            )}
          >
            {t(`tabs.${key}`)} {localizeDigits(String(tabCount(key, counts)), 'bn')}
          </a>
        ))}
      </nav>

      {page.items.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <NextIntlClientProvider messages={pickMessages(messages, ['myPosts', 'postErrors'])}>
          <ul className="grid gap-3 md:grid-cols-2">
            {page.items.map((post) => {
              const facts = cardFacts(schemas.get(post.categoryId) ?? null, post.fields, 'bn', {
                yes: tEditor('yes'),
                no: tEditor('no'),
              });
              const takenDown = post.status === 'rejected' || post.status === 'removed';
              return (
                <li key={post.id} data-post-id={post.id}>
                  <PostCard
                    data={{
                      title: post.title,
                      price: facts.price,
                      attributes: facts.attributes,
                      photoUrl: post.media[0]?.cardUrl ?? post.media[0]?.thumbUrl ?? null,
                      isSold: post.isSold,
                    }}
                    labels={{
                      priceOnRequest: tEditor('priceOnRequest'),
                      noPhotos: tEditor('noPhotos'),
                      sold: t('status.sold'),
                    }}
                    footer={
                      <div className="mt-3 space-y-2 text-sm">
                        <p className="text-muted-foreground">{t(`status.${post.status}`)}</p>
                        {takenDown && (
                          <div className="space-y-1 text-destructive">
                            <p>
                              {t('reason', {
                                reason: tReason(moderationReasonKey(post.moderationReason)),
                              })}
                            </p>
                            {post.moderationNote && (
                              <p>{t('moderatorNote', { note: post.moderationNote })}</p>
                            )}
                          </div>
                        )}
                        {post.status === 'live' && post.expiresAt && (
                          <p className="text-muted-foreground">
                            {t('expiresOn', { date: date(post.expiresAt) })}
                          </p>
                        )}
                        {post.isSold && post.soldPrice && (
                          <p className="text-muted-foreground">
                            {t('soldFor', { price: `৳ ${formatMoney(post.soldPrice, 'bn')}` })}
                          </p>
                        )}
                        <PostActions
                          post={{
                            id: post.id,
                            status: post.status,
                            hiddenByOwner: post.hiddenByOwner ?? false,
                          }}
                        />
                      </div>
                    }
                  />
                </li>
              );
            })}
          </ul>
        </NextIntlClientProvider>
      )}

      {page.nextCursor && (
        <a
          href={`/me/posts?tab=${tab}&cursor=${page.nextCursor}`}
          className="inline-block text-sm text-brand underline"
        >
          {t('loadMore')}
        </a>
      )}
    </section>
  );
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { BadgeCheck, MapPin } from 'lucide-react';
import { detailFieldValue, priceLine } from '@/lib/posts/detail-display';
import { loadSharedPost } from '@/lib/posts/share';

interface Props {
  params: Promise<{ code: string }>;
}

async function load(params: Props['params']) {
  const { code } = await params;
  return /^[a-z0-9]{4,32}$/.test(code) ? loadSharedPost(code) : null;
}

async function priceWords() {
  const t = await getTranslations('share');
  return {
    free: t('free'),
    onRequest: t('priceOnRequest'),
    negotiable: t('negotiable'),
    perMonth: t('perMonth'),
  };
}

/**
 * The OG card a shared link unfurls into (WhatsApp, Facebook, Messenger):
 * title, price and area, the cover photo's card variant.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const shared = await load(params);
  // A missing link or post is the not-found page, marked noindex. The status
  // stays 200 (a soft 404): the root loading.tsx has already streamed the
  // response by the time the lookup fails, as for every page-level notFound().
  if (!shared) notFound();
  const { link, post } = shared;
  const t = await getTranslations('share');
  const area = post.area?.bn ?? post.area?.en ?? null;
  const description = [priceLine(post, await priceWords()), area, post.category.name.bn]
    .filter(Boolean)
    .join(' · ');
  const cover = post.media.find((m) => m.variants)?.variants?.card;
  return {
    title: post.title,
    description,
    alternates: { canonical: link.url },
    openGraph: {
      type: 'website',
      url: link.url,
      siteName: t('siteName'),
      locale: 'bn_BD',
      title: post.title,
      description,
      ...(cover
        ? {
            images: [{ url: cover.url, width: cover.width, height: cover.height, alt: post.title }],
          }
        : {}),
    },
    twitter: { card: cover ? 'summary_large_image' : 'summary', title: post.title, description },
  };
}

/**
 * /s/:code — where a shared post link lands (ADR 036): a read-only preview
 * of the post and its OG metadata. The number isn't here (the API never puts
 * it in a detail); contacting the seller happens in the app, where it is
 * counted as a lead.
 */
export default async function SharedPostPage({ params }: Props) {
  const shared = await load(params);
  if (!shared) notFound();
  const { post } = shared;
  const t = await getTranslations('share');
  const words = await priceWords();
  const yesNo = { yes: t('yes'), no: t('no') };
  const photos = post.media.flatMap((m) => (m.variants ? [m.variants] : []));
  const facts = post.fields.flatMap((field) => {
    const shown = detailFieldValue(field, yesNo);
    const label = field.label.bn ?? field.label.en;
    return shown && label ? [{ key: field.key, label, shown }] : [];
  });
  const area = post.area?.bn ?? post.area?.en ?? null;

  return (
    <article className="mx-auto w-full max-w-3xl space-y-6">
      {photos.length > 0 && (
        <div className="flex snap-x gap-2 overflow-x-auto rounded-lg">
          {photos.map((photo, index) => (
            // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
            <img
              key={photo.full.url}
              src={photo.card.url}
              width={photo.card.width}
              height={photo.card.height}
              alt={t('photoAlt', { title: post.title, number: index + 1 })}
              className="h-64 w-auto shrink-0 snap-start rounded-lg object-cover"
              loading={index === 0 ? 'eager' : 'lazy'}
            />
          ))}
        </div>
      )}

      <header className="space-y-2">
        {post.isSold && (
          <span className="inline-block rounded bg-muted px-2 py-0.5 text-sm font-medium">
            {t('sold')}
          </span>
        )}
        <h1 className="text-2xl font-semibold">{post.title}</h1>
        <p className="text-xl font-bold text-brand">{priceLine(post, words)}</p>
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          {area && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-4" aria-hidden />
              {area}
            </span>
          )}
          <span>{post.category.name.bn ?? post.category.name.en}</span>
        </p>
      </header>

      {post.description && <p className="whitespace-pre-line">{post.description}</p>}

      {facts.length > 0 && (
        <section aria-labelledby="details" className="space-y-2">
          <h2 id="details" className="font-semibold">
            {t('details')}
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {facts.map((fact) => (
              <div key={fact.key} className="contents">
                <dt className="text-muted-foreground">{fact.label}</dt>
                <dd>{fact.shown}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section aria-labelledby="seller" className="space-y-2 rounded-lg border p-4">
        <h2 id="seller" className="font-semibold">
          {t('seller')}
        </h2>
        {post.seller.name && <p>{post.seller.name}</p>}
        {post.seller.badges.length > 0 && (
          <ul className="flex flex-wrap gap-2 text-sm">
            {post.seller.badges.map((badge) => (
              <li
                key={badge}
                className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5"
              >
                <BadgeCheck className="size-4 text-brand" aria-hidden />
                {t.has(`badges.${badge}`) ? t(`badges.${badge}`) : badge}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted-foreground">{t('contactInApp')}</p>
      </section>
    </article>
  );
}

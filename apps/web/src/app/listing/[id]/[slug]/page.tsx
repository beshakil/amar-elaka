import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { BadgeCheck, MapPin, MessageSquare } from 'lucide-react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import { Breadcrumbs } from '@/components/listings/breadcrumbs';
import { ContactActions } from '@/components/listings/contact-actions';
import { buttonVariants } from '@/components/ui/button';
import { ListingGrid } from '@/components/listings/listing-grid';
import { SaveButton } from '@/components/listings/save-button';
import { ViewBeacon } from '@/components/listings/view-beacon';
import type { PostDetail, TenantConfig } from '@/lib/api/schemas';
import { pickMessages } from '@/lib/i18n-messages';
import { cardFromPost, priceDigits, priceLabel, type PriceWords } from '@/lib/listings/format';
import { listingDetail, listingStatus } from '@/lib/listings/load';
import { detailFieldValue } from '@/lib/posts/detail-display';
import { breadcrumbJsonLd, jsonLdScript } from '@/lib/seo/json-ld';
import { productJsonLd } from '@/lib/seo/listing-jsonld';
import { listingPath } from '@/lib/seo/slug';
import { currentOrigin, currentTenantConfig } from '@/lib/tenant';

interface Props {
  params: Promise<{ id: string; slug: string }>;
}

/** The listing as the page and its metadata both need it (cached per request). */
async function load(params: Props['params']) {
  const { id } = await params;
  const tenant = await currentTenantConfig();
  if (!tenant) return null;
  // middleware.ts already answered 410/404/308; these reads are cached.
  const [status, post] = await Promise.all([listingStatus(tenant, id), listingDetail(tenant, id)]);
  if (!post || (status.state !== 'live' && status.state !== 'sold')) notFound();
  return { tenant, status, post, origin: await currentOrigin() };
}

async function priceWords(): Promise<PriceWords> {
  const t = await getTranslations('listing');
  return {
    free: t('free'),
    priceOnRequest: t('priceOnRequest'),
    negotiable: t('negotiable'),
    perMonth: t('perMonth'),
  };
}

const area = (post: PostDetail) => post.area?.bn ?? post.area?.en ?? null;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const loaded = await load(params);
  if (!loaded) return {};
  const { tenant, status, post } = loaded;
  const t = await getTranslations('seo');
  const where = { area: area(post) ?? tenant.nameBn, tenant: tenant.nameBn };
  const sold = post.isSold ? t('listingSoldSuffix') : '';
  const title =
    (post.price
      ? t('listingTitle', { title: post.title, price: priceDigits(post.price), ...where })
      : t('listingTitleNoPrice', { title: post.title, ...where })) + sold;
  const category = post.category.name.bn ?? post.category.slug;
  const description = post.price
    ? t('listingDescription', {
        category,
        title: post.title,
        price: priceDigits(post.price),
        ...where,
      })
    : t('listingDescriptionNoPrice', { category, title: post.title, ...where });
  const path = listingPath(post.id, post.title);
  const image = `/og/listing/${post.id}?v=${encodeURIComponent(post.updatedAt)}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    // A sold listing stays up but leaves the index after sold_noindex_days.
    robots: { index: status.indexable, follow: true },
    openGraph: {
      type: 'website',
      url: path,
      title,
      description,
      locale: 'bn_BD',
      images: [{ url: image, width: 1200, height: 630, alt: post.title }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

/**
 * A public listing (ADR 039): server-rendered, cached reads, Product +
 * Offer and BreadcrumbList JSON-LD. Never the seller's number: the contact
 * buttons ask for it (and record the lead) only when tapped.
 */
export default async function ListingPage({ params }: Props) {
  const loaded = await load(params);
  if (!loaded) return <NoCoverage />;
  const { tenant, post, origin } = loaded;
  const t = await getTranslations('listing');
  const tChat = await getTranslations('chat');
  const words = await priceWords();
  const messages = await getMessages();
  const path = listingPath(post.id, post.title);
  const url = new URL(path, origin).toString();
  const photos = post.media.flatMap((m) => (m.variants ? [m.variants] : []));
  const crumbs = [
    { name: t('home'), path: '/' },
    {
      name: post.category.name.bn ?? post.category.slug,
      path: `/category/${post.category.slug}`,
    },
    { name: post.title, path },
  ];
  const facts = post.fields.flatMap((field) => {
    if (field.key === 'price') return [];
    const shown = detailFieldValue(field, { yes: t('yes'), no: t('no') });
    const label = field.label.bn ?? field.label.en;
    return shown && label ? [{ key: field.key, label, shown }] : [];
  });
  const loginPath = `/login?next=${encodeURIComponent(path)}`;

  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD has no other supported form; jsonLdScript escapes the payload.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(
            productJsonLd(
              post,
              url,
              photos.map((p) => p.full.url),
              tenant,
            ),
            breadcrumbJsonLd(crumbs, origin),
          ),
        }}
      />
      <ViewBeacon postId={post.id} />
      <Breadcrumbs items={crumbs} />

      <article className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Gallery
          photos={photos}
          title={post.title}
          photoLabel={(n) =>
            t('photo', { title: post.title, number: localizeDigits(String(n), 'bn') })
          }
        />

        <div className="space-y-4">
          {post.isSold && (
            <p
              className="rounded-md bg-muted px-3 py-2 text-sm font-medium"
              data-testid="sold-note"
            >
              {t('soldNote')}
            </p>
          )}
          <h1 className="text-2xl font-semibold">{post.title}</h1>
          <p className="text-2xl font-bold text-brand">
            {priceLabel(post.price, post.priceType, words)}
            {post.priceType === 'negotiable' && post.price && (
              <span className="ml-2 text-base font-normal text-muted-foreground">
                ({words.negotiable})
              </span>
            )}
          </p>
          <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-4" aria-hidden />
              {[area(post), tenant.nameBn].filter(Boolean).join(', ')}
            </span>
            <span>{post.category.name.bn}</span>
          </p>

          <NextIntlClientProvider messages={pickMessages(messages, ['listing'])}>
            <ContactActions
              postId={post.id}
              channels={post.contact.channels}
              sold={post.isSold}
              loginPath={loginPath}
            />
            <SaveButton postId={post.id} loginPath={loginPath} />
          </NextIntlClientProvider>

          {/* Chat (ADR 060): sign-in, if needed, comes first (middleware) and returns here. */}
          {post.contact.allowChat && !post.isSold && (
            <Link
              href={`/inbox/new?post=${post.id}` as Route}
              className={buttonVariants({ variant: 'outline' })}
              data-testid="listing-chat"
              rel="nofollow"
            >
              <MessageSquare className="size-4" aria-hidden />
              {tChat('messageButton')}
            </Link>
          )}

          <Seller post={post} tenant={tenant} />
        </div>
      </article>

      {facts.length > 0 && (
        <section aria-labelledby="details" className="mt-8">
          <h2 id="details" className="mb-2 text-lg font-semibold">
            {t('details')}
          </h2>
          <dl className="grid grid-cols-[auto_1fr] overflow-hidden rounded-md border border-border text-sm">
            {facts.map((fact) => (
              <div
                key={fact.key}
                className="contents [&>*]:border-b [&>*]:border-border [&>*]:px-3 [&>*]:py-2"
              >
                <dt className="bg-muted/50 text-muted-foreground">{fact.label}</dt>
                <dd>{fact.shown}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {post.description && (
        <section aria-labelledby="description" className="mt-8">
          <h2 id="description" className="mb-2 text-lg font-semibold">
            {t('description')}
          </h2>
          <p className="whitespace-pre-line">{post.description}</p>
        </section>
      )}

      {post.similar.length > 0 && (
        <section aria-labelledby="similar" className="mt-10">
          <h2 id="similar" className="mb-3 text-lg font-semibold">
            {t('similar')}
          </h2>
          <ListingGrid
            cards={post.similar.map((card) => cardFromPost(card, words))}
            badgeLabel={(code) => (t.has(`badges.${code}`) ? t(`badges.${code}`) : null)}
            soldLabel={t('sold')}
            eager={0}
          />
        </section>
      )}
    </>
  );
}

function Gallery({
  photos,
  title,
  photoLabel,
}: {
  photos: NonNullable<PostDetail['media'][number]['variants']>[];
  title: string;
  photoLabel: (n: number) => string;
}) {
  const [first, ...rest] = photos;
  if (!first) return <div className="aspect-[4/3] rounded-lg bg-muted" aria-hidden />;
  return (
    <div className="space-y-2">
      <a href={first.full.url} className="block overflow-hidden rounded-lg bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time */}
        <img
          src={first.card.url}
          srcSet={`${first.card.url} ${first.card.width}w, ${first.full.url} ${first.full.width}w`}
          sizes="(min-width: 1024px) 60vw, 100vw"
          width={first.card.width}
          height={first.card.height}
          alt={photoLabel(1)}
          fetchPriority="high"
          className="aspect-[4/3] w-full object-cover"
        />
      </a>
      {rest.length > 0 && (
        <ul className="grid grid-cols-4 gap-2">
          {rest.map((photo, index) => (
            <li key={photo.full.url}>
              <a href={photo.full.url} className="block overflow-hidden rounded-md bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time */}
                <img
                  src={photo.thumb.url}
                  width={photo.thumb.width}
                  height={photo.thumb.height}
                  alt={photoLabel(index + 2)}
                  loading="lazy"
                  decoding="async"
                  className="aspect-square w-full object-cover"
                />
              </a>
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only">{title}</span>
    </div>
  );
}

async function Seller({ post, tenant }: { post: PostDetail; tenant: TenantConfig }) {
  const t = await getTranslations('listing');
  const since = post.seller.memberSince
    ? new Intl.DateTimeFormat('bn-BD', { year: 'numeric', month: 'long' }).format(
        new Date(post.seller.memberSince),
      )
    : null;
  const store = post.seller.store;
  return (
    <section aria-labelledby="seller" className="rounded-lg border border-border p-4">
      <h2 id="seller" className="text-sm text-muted-foreground">
        {t('seller')}
      </h2>
      <p className="mt-1 font-semibold">{post.seller.name ?? tenant.nameBn}</p>
      {since && (
        <p className="text-sm text-muted-foreground">{t('memberSince', { date: since })}</p>
      )}
      {post.seller.badges.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2 text-sm">
          {post.seller.badges.map((badge) => (
            <li key={badge} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5">
              <BadgeCheck className="size-4 text-brand" aria-hidden />
              {t.has(`badges.${badge}`) ? t(`badges.${badge}`) : badge}
            </li>
          ))}
        </ul>
      )}
      {store && (
        <a
          href={`/store/${store.slug}`}
          className="mt-3 inline-block text-sm text-brand hover:underline"
        >
          {t('store')}: {store.name.bn ?? store.slug}
        </a>
      )}
    </section>
  );
}

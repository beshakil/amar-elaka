import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { formatMoney } from '@amar-elaka/dynamic-form';
import { areaTimeZone, InfoShell } from '@/components/info/info-page';
import { ContactActions } from '@/components/listings/contact-actions';
import { NoCoverage } from '@/components/no-coverage';
import { pickMessages } from '@/lib/i18n-messages';
import { moment } from '@/lib/info/engine-format';
import { lostFoundDetail } from '@/lib/info/engine';
import { currentTenantConfig } from '@/lib/tenant';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const tenant = await currentTenantConfig();
  const item = tenant ? await lostFoundDetail(tenant, (await params).id) : null;
  if (!item) return {};
  return {
    title: item.card.title.bn ?? item.card.title.en ?? undefined,
    description: item.description?.slice(0, 160),
    alternates: { canonical: `/info/lost-found/${item.card.id}` },
    // People's reports: not for search engines.
    robots: { index: false },
  };
}

/**
 * One lost & found report (ADR 065): photos, where and when last seen, the
 * reward — and the reporter's number only through the tracked contact.
 */
export default async function LostFoundItemPage({ params }: Props) {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;
  const [item, timeZone, t, messages] = await Promise.all([
    lostFoundDetail(tenant, (await params).id),
    areaTimeZone(tenant),
    getTranslations('infoEngine'),
    getMessages(),
  ]);
  if (!item) notFound();
  const path = `/info/lost-found/${item.card.id}`;
  const badge = (code: string) => (t.has(`badges.${code}`) ? t(`badges.${code}`) : null);
  return (
    <InfoShell
      title={item.card.title.bn ?? item.card.title.en ?? ''}
      path={path}
      trail={[{ name: t('hub.lostFound'), path: '/info/lost-found' }]}
    >
      <p className="mt-2 flex flex-wrap gap-2">
        {[item.kind, item.itemType].map((code) =>
          badge(code) ? (
            <span key={code} className="rounded bg-muted px-2 py-0.5 text-sm">
              {badge(code)}
            </span>
          ) : null,
        )}
      </p>
      {item.photos.length > 0 ? (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {item.photos.map((p) => (
            <li key={p.id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a public media variant */}
              <img
                src={p.url}
                alt=""
                loading="lazy"
                className="aspect-square w-full rounded-lg object-cover"
              />
            </li>
          ))}
        </ul>
      ) : null}
      {item.lastSeenAt ? (
        <p className="mt-4">{t('lastSeen', { when: moment(item.lastSeenAt, timeZone) })}</p>
      ) : null}
      {item.locationText ? <p className="text-muted-foreground">{item.locationText}</p> : null}
      {item.description ? <p className="mt-4 whitespace-pre-line">{item.description}</p> : null}
      {item.reward ? (
        <p className="mt-2 font-semibold">
          {t('lostFound.reward', { amount: `৳ ${formatMoney(item.reward, 'bn')}` })}
        </p>
      ) : null}
      {item.itemType === 'person' ? (
        <p className="mt-4 text-sm text-destructive">{t('lostFound.personNote')}</p>
      ) : null}
      <div className="mt-6">
        {item.status === 'resolved' ? (
          <p className="text-muted-foreground">{t('lostFound.resolved')}</p>
        ) : (
          <NextIntlClientProvider messages={pickMessages(messages, ['listing'])}>
            <ContactActions
              postId={item.card.id}
              channels={['call', 'whatsapp']}
              sold={false}
              loginPath={`/login?next=${encodeURIComponent(path)}`}
              endpoint={`/api/info/lost-found/${item.card.id}/contact`}
            />
          </NextIntlClientProvider>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{t('lostFound.phoneNote')}</p>
      </div>
    </InfoShell>
  );
}

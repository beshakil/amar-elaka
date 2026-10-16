import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  Bus,
  Droplet,
  Hospital,
  Landmark,
  Megaphone,
  Moon,
  Phone,
  PowerOff,
  SearchCheck,
  ShoppingBasket,
  Sprout,
  Users,
} from 'lucide-react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import type { EmergencyPage } from '@/lib/api/schemas';
import { groupBy } from '@/lib/info/bazar';
import { infoServices } from '@/lib/info/engine';
import { emergencyPage } from '@/lib/info/load';
import { breadcrumbJsonLd, jsonLdScript } from '@/lib/seo/json-ld';
import { currentOrigin, currentTenantConfig, tenantConfigForChrome } from '@/lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const [tenant, t] = await Promise.all([tenantConfigForChrome(), getTranslations('nav')]);
  return {
    title: t('info'),
    description: tenant?.nameBn,
    alternates: { canonical: '/info' },
  };
}

/**
 * The area's local information (ADR 064): the emergency numbers — national
 * helplines and local contacts near the area, grouped by type, each a tap to
 * call — then every local information service (ADR 064/065). If the API can't
 * answer, the emergency numbers the tenant config carries still render.
 */
export default async function InfoPage() {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;

  const t = await getTranslations('info');
  const tNav = await getTranslations('nav');
  const breadcrumbs = [
    { name: tNav('home'), path: '/' },
    { name: tNav('info'), path: '/info' },
  ];
  const page: EmergencyPage | null = await emergencyPage(tenant).catch(() => null);
  const groups =
    page?.groups ??
    // The tenant config's local numbers: the page never goes blank.
    groupBy(tenant.emergencyNumbers, (contact) => contact.serviceType).map(
      ([serviceType, contacts]) => ({
        serviceType,
        contacts: contacts.map((c) => ({
          id: `${c.serviceType}-${c.nameBn}`,
          name: { bn: c.nameBn, en: c.nameEn },
          phones: c.phones,
          address: null,
          is24h: c.is24h,
          availabilityNote: null,
          distanceMeters: null,
        })),
      }),
    );
  const tHub = await getTranslations('infoEngine.hub');
  const agri = await infoServices(tenant)
    .then((x) => x.agri)
    .catch(() => false);
  const services = [
    {
      href: '#blood',
      icon: Droplet,
      title: t('bloodHeading'),
      body: t('bloodLinkBody'),
      danger: true,
    },
    { href: '/info/outages', icon: PowerOff, title: tHub('outages'), body: tHub('outagesBody') },
    { href: '/info/prayer', icon: Moon, title: tHub('prayer'), body: tHub('prayerBody') },
    { href: '/info/bazar', icon: ShoppingBasket, title: t('bazarLink'), body: t('bazarLinkBody') },
    { href: '/info/transport', icon: Bus, title: tHub('transport'), body: tHub('transportBody') },
    {
      href: '/info/notices?category=local',
      icon: Megaphone,
      title: tHub('notices'),
      body: tHub('noticesBody'),
    },
    {
      href: '/info/notices?category=community',
      icon: Users,
      title: tHub('community'),
      body: tHub('communityBody'),
    },
    {
      href: '/info/lost-found',
      icon: SearchCheck,
      title: tHub('lostFound'),
      body: tHub('lostFoundBody'),
    },
    {
      href: '/info/directory',
      icon: Hospital,
      title: tHub('directory'),
      body: tHub('directoryBody'),
    },
    { href: '/info/gov', icon: Landmark, title: tHub('gov'), body: tHub('govBody') },
    ...(agri
      ? [{ href: '/info/agri', icon: Sprout, title: tHub('agri'), body: tHub('agriBody') }]
      : []),
  ];
  const typeLabel = (code: string) => (t.has(`types.${code}`) ? t(`types.${code}`) : code);
  const hasSupport = tenant.support.phoneE164 !== null || tenant.support.email !== null;

  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD has no other supported form; jsonLdScript escapes the payload.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(breadcrumbJsonLd(breadcrumbs, await currentOrigin())),
        }}
      />
      <h1 className="text-2xl font-semibold">{tNav('info')}</h1>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {services.map(({ href, icon: Icon, title, body, danger }) => (
          <li key={href}>
            <Link
              href={href as Route}
              className="flex h-full items-center gap-3 rounded-lg border border-border p-4 hover:bg-muted"
            >
              <Icon
                className={`size-6 shrink-0 ${danger ? 'text-red-600' : 'text-brand'}`}
                aria-hidden
              />
              <span>
                <span className="block font-semibold">{title}</span>
                <span className="text-sm text-muted-foreground">{body}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <section className="mt-8" aria-labelledby="emergency">
        <h2 id="emergency" className="text-xl font-semibold">
          {t('emergencyHeading')}
        </h2>
        {page && page.national.length > 0 ? (
          <>
            <h3 className="mt-4 font-medium">{t('nationalHeading')}</h3>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {page.national.map((h) => (
                <li key={h.id}>
                  <a
                    href={`tel:${h.dial}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 hover:bg-muted"
                  >
                    <span>
                      <span className="block font-medium">{h.name.bn ?? h.name.en}</span>
                      {h.description.bn ? (
                        <span className="text-sm text-muted-foreground">{h.description.bn}</span>
                      ) : null}
                    </span>
                    <span className="inline-flex items-center gap-1 text-lg font-semibold text-brand">
                      <Phone className="size-4" aria-hidden />
                      {localizeDigits(h.dial, 'bn')}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <h3 className="mt-6 font-medium">{t('localHeading')}</h3>
        {groups.length === 0 ? (
          <p className="mt-2 text-muted-foreground">{t('noLocal')}</p>
        ) : (
          groups.map((group) => (
            <div key={group.serviceType} className="mt-4">
              <h4 className="text-sm font-medium text-muted-foreground">
                {typeLabel(group.serviceType)}
              </h4>
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-card">
                {group.contacts.map((contact) => (
                  <li
                    key={contact.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                  >
                    <span>
                      {contact.name.bn ?? contact.name.en}
                      {contact.is24h ? (
                        <span className="ml-2 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {t('hours24')}
                        </span>
                      ) : null}
                      {contact.address ? (
                        <span className="block text-sm text-muted-foreground">
                          {contact.address}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex gap-3">
                      {contact.phones.map((phone) => (
                        <a key={phone} href={`tel:${phone}`} className="text-brand hover:underline">
                          {localizeDigits(phone, 'bn')}
                        </a>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <section id="blood" className="mt-8" aria-labelledby="blood-heading">
        <h2 id="blood-heading" className="text-xl font-semibold">
          {t('bloodHeading')}
        </h2>
        <p className="mt-2 text-muted-foreground">{t('bloodBody')}</p>
      </section>

      {hasSupport ? (
        <section className="mt-8">
          <h2 className="text-xl font-semibold">{t('supportHeading')}</h2>
          <ul className="mt-4 space-y-2">
            {tenant.support.phoneE164 ? (
              <li>
                <a href={`tel:${tenant.support.phoneE164}`} className="text-brand hover:underline">
                  {tenant.support.phoneE164}
                </a>
              </li>
            ) : null}
            {tenant.support.email ? (
              <li>
                <a href={`mailto:${tenant.support.email}`} className="text-brand hover:underline">
                  {tenant.support.email}
                </a>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </>
  );
}

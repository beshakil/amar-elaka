import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Phone } from 'lucide-react';
import { formatMoney, localizeDigits } from '@amar-elaka/dynamic-form';
import { areaTimeZone, InfoShell } from '@/components/info/info-page';
import { NoCoverage } from '@/components/no-coverage';
import { clock, day } from '@/lib/info/engine-format';
import { routeDetail } from '@/lib/info/engine';
import { currentTenantConfig } from '@/lib/tenant';

type Props = { params: Promise<{ id: string }> };

// settings-exempt: ISO weekdays (Monday = 1 … Sunday = 7) — a calendar fact
const WEEK = 7;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const tenant = await currentTenantConfig();
  const route = tenant ? await routeDetail(tenant, (await params).id) : null;
  if (!route) return {};
  return {
    title: route.card.title.bn ?? route.card.title.en ?? undefined,
    description: `${route.originName} – ${route.destinationName}`,
    alternates: { canonical: `/info/transport/${route.card.id}` },
  };
}

/**
 * One route (ADR 065): the next departures from now, the timetable, stops,
 * fares and the operator — kept by the area team, with "last verified".
 */
export default async function RoutePage({ params }: Props) {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;
  const [route, timeZone, t] = await Promise.all([
    routeDetail(tenant, (await params).id),
    areaTimeZone(tenant),
    getTranslations('infoEngine'),
  ]);
  if (!route) notFound();
  const money = (v: string) => `৳ ${formatMoney(v, 'bn')}`;
  const low = route.fareMin ?? route.fareMax;
  const high = route.fareMax ?? route.fareMin;
  const fare = low && high ? (low === high ? money(low) : `${money(low)} – ${money(high)}`) : null;
  const days = (list: number[]) =>
    list.length === WEEK
      ? t('transport.everyDay')
      : list.map((d) => t(`transport.days.${d - 1}`)).join(', ');
  return (
    <InfoShell
      title={route.card.title.bn ?? route.card.title.en ?? ''}
      path={`/info/transport/${route.card.id}`}
      trail={[{ name: t('hub.transport'), path: '/info/transport' }]}
    >
      <p className="mt-1 text-muted-foreground">
        {route.originName} → {route.destinationName}
      </p>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {t.has(`badges.${route.mode}`) ? <span>{t(`badges.${route.mode}`)}</span> : null}
        {route.operatorName ? (
          <span>{t('transport.operator', { name: route.operatorName })}</span>
        ) : null}
        {route.typicalDurationMinutes ? (
          <span>
            {t('transport.duration', {
              minutes: localizeDigits(String(route.typicalDurationMinutes), 'bn'),
            })}
          </span>
        ) : null}
        {fare ? <span>{t('transport.fare', { range: fare })}</span> : null}
      </p>
      {route.card.isStale ? (
        <p
          role="status"
          className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          {t('stale')}
        </p>
      ) : null}

      <section className="mt-6" aria-labelledby="next">
        <h2 id="next" className="font-semibold">
          {t('transport.next')}
        </h2>
        {route.nextDepartures.length === 0 ? (
          <p className="mt-2 text-muted-foreground">{t('transport.noNext')}</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {route.nextDepartures.map((d) => (
              <li
                key={`${d.departsAt}-${d.direction}`}
                className="rounded-lg border border-border px-3 py-2"
              >
                <span className="block text-lg font-semibold">{clock(d.departsAt, timeZone)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`transport.${d.direction === 'return' ? 'return' : 'outbound'}`)}
                  {d.serviceClass ? ` · ${d.serviceClass}` : ''}
                  {d.fare ? ` · ${money(d.fare)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {route.schedules.length > 0 ? (
        <section className="mt-6" aria-labelledby="timetable">
          <h2 id="timetable" className="font-semibold">
            {t('transport.timetable')}
          </h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {route.schedules.map((s) => (
                  <tr key={s.id}>
                    <td className="px-3 py-2 font-semibold">
                      {localizeDigits(s.departureTime.slice(0, 5), 'bn')}
                    </td>
                    <td className="px-3 py-2">
                      {t(`transport.${s.direction === 'return' ? 'return' : 'outbound'}`)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{days(s.days)}</td>
                    <td className="px-3 py-2">{s.fare ? money(s.fare) : (s.serviceClass ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {route.stops.length > 0 ? (
        <section className="mt-6" aria-labelledby="stops">
          <h2 id="stops" className="font-semibold">
            {t('transport.stops')}
          </h2>
          <ol className="mt-2 space-y-1">
            {route.stops.map((s) => (
              <li key={s.seq} className="flex justify-between gap-3 border-b border-border py-1">
                <span>{s.name.bn ?? s.name.en}</span>
                <span className="text-sm text-muted-foreground">
                  {s.minutesFromOrigin !== null
                    ? t('transport.minutesFrom', {
                        minutes: localizeDigits(String(s.minutesFromOrigin), 'bn'),
                      })
                    : ''}
                  {s.fareFromOrigin ? ` · ${money(s.fareFromOrigin)}` : ''}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {route.contactPhones.length > 0 ? (
        <p className="mt-6 flex flex-wrap gap-3">
          {route.contactPhones.map((phone) => (
            <a
              key={phone}
              href={`tel:${phone}`}
              className="inline-flex items-center gap-1 text-brand hover:underline"
            >
              <Phone className="size-4" aria-hidden />
              {localizeDigits(phone, 'bn')}
            </a>
          ))}
        </p>
      ) : null}
      {route.notes ? <p className="mt-4 text-sm text-muted-foreground">{route.notes}</p> : null}
      <p className="mt-6 text-xs text-muted-foreground">
        {route.lastVerifiedAt
          ? t('transport.verified', { date: day(route.lastVerifiedAt, timeZone) })
          : null}
        {route.fareUpdatedOn
          ? ` · ${t('transport.fareUpdated', { date: day(route.fareUpdatedOn, timeZone) })}`
          : null}
      </p>
    </InfoShell>
  );
}

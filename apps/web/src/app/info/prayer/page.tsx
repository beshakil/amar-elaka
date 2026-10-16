import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { InfoShell } from '@/components/info/info-page';
import { NoCoverage } from '@/components/no-coverage';
import { clock } from '@/lib/info/engine-format';
import { prayerSettings } from '@/lib/info/engine';
import {
  hijriDate,
  localDate,
  nextPrayer,
  PRAYER_NAMES,
  prayerTimes,
  RAMADAN,
  sehriIftar,
} from '@/lib/info/prayer';
import { currentTenantConfig } from '@/lib/tenant';

// A month of rows: Ramadan's length at most (a calendar fact).
const RAMADAN_ROWS = 30;
// settings-exempt: one day in milliseconds — a calendar fact
const DAY_MS = 86_400_000;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('infoEngine.hub');
  return {
    title: t('prayer'),
    description: t('prayerBody'),
    alternates: { canonical: '/info/prayer' },
  };
}

/**
 * Prayer times (ADR 065), calculated here from the area's centre with the
 * area's method — no API. Today, the next prayer, the Hijri date, and in
 * Ramadan (or on request) the month's sehri and iftar. The app uses the
 * phone's own position.
 */
export default async function PrayerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;
  const [s, t, query] = await Promise.all([
    prayerSettings(tenant),
    getTranslations('infoEngine'),
    searchParams,
  ]);
  const at = s.center ?? tenant.mapCenter;
  const tz = s.timezone;
  const now = new Date();
  const today = localDate(now, tz);
  const options = { method: s.method, asrSchool: s.asrSchool };
  const times = prayerTimes(today, at.lat, at.lng, options);
  const tomorrow = prayerTimes(
    localDate(new Date(now.getTime() + DAY_MS), tz),
    at.lat,
    at.lng,
    options,
  );
  const upcoming = nextPrayer(times, tomorrow, now);
  const next = { p: upcoming.prayer, at: upcoming.at };
  const h = hijriDate(today, s.hijriAdjustDays);
  const inRamadan = h.month === RAMADAN;
  const showTable = inRamadan || query.ramadan === '1';
  const n = (v: number) => localizeDigits(String(v), 'bn');
  const si = sehriIftar(times, s.sehriCautionMinutes, s.iftarCautionMinutes);

  return (
    <InfoShell title={t('hub.prayer')} path="/info/prayer">
      <p className="mt-2 text-lg">
        {t('prayer.hijri', {
          day: n(h.day),
          month: t(`prayer.months.${h.month - 1}`),
          year: n(h.year),
        })}
      </p>
      <p className="mt-2 text-xl font-semibold text-brand" data-testid="next-prayer">
        {t('prayer.next', {
          name: t(`prayer.names.${next.p}`),
          time: clock(next.at.toISOString(), tz),
        })}
      </p>
      <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
        {PRAYER_NAMES.map((p) => (
          <li
            key={p}
            className={`flex justify-between px-4 py-3 ${p === next.p && times[p].getTime() === next.at.getTime() ? 'bg-muted font-semibold' : ''}`}
          >
            <span>{t(`prayer.names.${p}`)}</span>
            <span>{clock(times[p].toISOString(), tz)}</span>
          </li>
        ))}
      </ul>
      {inRamadan ? (
        <div className="mt-4 grid grid-cols-2 gap-3 text-center">
          <div className="rounded-lg border border-border p-3">
            <span className="block text-sm">{t('prayer.sehriEnds')}</span>
            <span className="text-xl font-semibold">{clock(si.sehriEnds.toISOString(), tz)}</span>
          </div>
          <div className="rounded-lg border border-border p-3">
            <span className="block text-sm">{t('prayer.iftar')}</span>
            <span className="text-xl font-semibold">{clock(si.iftar.toISOString(), tz)}</span>
          </div>
        </div>
      ) : null}

      <section className="mt-6">
        {inRamadan ? (
          <h2 className="font-semibold">{t('prayer.ramadan')}</h2>
        ) : (
          <Link
            href={showTable ? '/info/prayer' : '/info/prayer?ramadan=1'}
            className="text-brand hover:underline"
          >
            {t('prayer.ramadan')}
          </Link>
        )}
        {showTable ? (
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('prayer.date')}</th>
                  <th className="px-3 py-2 font-medium">{t('prayer.sehriEnds')}</th>
                  <th className="px-3 py-2 font-medium">{t('prayer.iftar')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Array.from({ length: RAMADAN_ROWS }, (_, i) => {
                  const date = localDate(new Date(now.getTime() + i * DAY_MS), tz);
                  const row = sehriIftar(
                    prayerTimes(date, at.lat, at.lng, options),
                    s.sehriCautionMinutes,
                    s.iftarCautionMinutes,
                  );
                  const hd = hijriDate(date, s.hijriAdjustDays);
                  return (
                    <tr key={date}>
                      <td className="px-3 py-2">
                        {new Intl.DateTimeFormat('bn-BD', {
                          day: 'numeric',
                          month: 'short',
                          timeZone: 'UTC',
                        }).format(new Date(`${date}T00:00:00Z`))}
                        {hd.month === RAMADAN ? ` · ${n(hd.day)}` : ''}
                      </td>
                      <td className="px-3 py-2">{clock(row.sehriEnds.toISOString(), tz)}</td>
                      <td className="px-3 py-2">{clock(row.iftar.toISOString(), tz)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <p className="mt-6 text-xs text-muted-foreground">
        {t('prayer.basis', {
          method: t(`prayer.methods.${s.method}`),
          school: s.asrSchool === 'hanafi' ? t('prayer.hanafi') : t('prayer.standard'),
        })}
      </p>
      <p className="text-xs text-muted-foreground">{t('prayer.appNote')}</p>
    </InfoShell>
  );
}

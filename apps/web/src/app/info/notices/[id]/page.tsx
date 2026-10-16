import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { BadgeCheck, FileText } from 'lucide-react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { areaTimeZone, InfoShell } from '@/components/info/info-page';
import { NoCoverage } from '@/components/no-coverage';
import type { NoticeDetail } from '@/lib/api/schemas';
import { day, moment } from '@/lib/info/engine-format';
import { noticeDetail } from '@/lib/info/engine';
import { currentTenantConfig } from '@/lib/tenant';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const tenant = await currentTenantConfig();
  const notice = tenant ? await noticeDetail(tenant, (await params).id) : null;
  if (!notice) return {};
  return {
    title: notice.card.title.bn ?? notice.card.title.en ?? undefined,
    description: notice.body.slice(0, 160),
    alternates: { canonical: `/info/notices/${notice.card.id}` },
  };
}

/**
 * One notice (ADR 065): the body, who issued it, until when, attachments
 * (documents through a short-lived link) — and a janaza or condolence notice
 * in its respectful template, the same wording as the app.
 */
export default async function NoticePage({ params }: Props) {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;
  const [notice, timeZone, t] = await Promise.all([
    noticeDetail(tenant, (await params).id),
    areaTimeZone(tenant),
    getTranslations('infoEngine'),
  ]);
  if (!notice) notFound();
  const title = notice.card.title.bn ?? notice.card.title.en ?? '';
  return (
    <InfoShell
      title={title}
      path={`/info/notices/${notice.card.id}`}
      trail={[{ name: t('hub.notices'), path: '/info/notices' }]}
    >
      <p className="mt-2 flex flex-wrap gap-2 text-sm text-muted-foreground">
        {t.has(`badges.${notice.type}`) ? <span>{t(`badges.${notice.type}`)}</span> : null}
        {notice.isOfficial ? (
          <span className="inline-flex items-center gap-1 text-brand">
            <BadgeCheck className="size-4" aria-hidden />
            {t('badges.official')}
          </span>
        ) : null}
        {notice.publishedAt ? <span>{day(notice.publishedAt, timeZone)}</span> : null}
      </p>
      {notice.template ? <TemplateBlock notice={notice} timeZone={timeZone} /> : null}
      <p className="mt-4 whitespace-pre-line">{notice.body}</p>
      {notice.issuerName ? (
        <p className="mt-4 text-sm">{t('notices.issuer', { name: notice.issuerName })}</p>
      ) : null}
      {notice.expiresAt ? (
        <p className="text-sm text-muted-foreground">
          {t('notices.validUntil', { date: day(notice.expiresAt, timeZone) })}
        </p>
      ) : null}
      {notice.attachments.length > 0 ? (
        <section className="mt-6">
          <h2 className="font-semibold">{t('notices.attachments')}</h2>
          <ul className="mt-2 grid gap-3 sm:grid-cols-2">
            {notice.attachments.map((a) =>
              a.kind === 'image' ? (
                <li key={a.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a public media variant */}
                  <img
                    src={a.url}
                    alt=""
                    loading="lazy"
                    className="w-full rounded-lg border border-border"
                  />
                </li>
              ) : (
                <li key={a.id}>
                  <a
                    href={a.url}
                    rel="noopener"
                    className="flex items-center gap-2 rounded-lg border border-border p-3 hover:bg-muted"
                  >
                    <FileText className="size-5 text-brand" aria-hidden />
                    {t('notices.open')}
                  </a>
                </li>
              ),
            )}
          </ul>
        </section>
      ) : null}
    </InfoShell>
  );
}

/** A janaza or condolence notice's respectful wording (the app's own). */
async function TemplateBlock({ notice, timeZone }: { notice: NoticeDetail; timeZone: string }) {
  const t = await getTranslations('infoEngine');
  const f = notice.templateFields as {
    deceasedName?: string;
    age?: number | null;
    relation?: string | null;
    janazaAt?: string | null;
    janazaPlace?: string | null;
    burialPlace?: string | null;
  };
  const name = f.deceasedName ?? '';
  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4 text-center">
      <p className="font-semibold">{t('notices.inna')}</p>
      <p className="mt-2">
        {typeof f.age === 'number'
          ? t('notices.passedAge', { name, age: localizeDigits(String(f.age), 'bn') })
          : t('notices.passed', { name })}
      </p>
      {f.relation ? <p className="text-sm text-muted-foreground">{f.relation}</p> : null}
      {notice.template === 'janaza' && f.janazaAt ? (
        <p className="mt-2">{t('notices.janazaAt', { when: moment(f.janazaAt, timeZone) })}</p>
      ) : null}
      {notice.template === 'janaza' && f.janazaPlace ? (
        <p>{t('notices.janazaPlace', { place: f.janazaPlace })}</p>
      ) : null}
      {f.burialPlace ? <p>{t('notices.burialAt', { place: f.burialPlace })}</p> : null}
      {notice.template === 'condolence' ? (
        <p className="mt-2 text-sm">{t('notices.condolence')}</p>
      ) : null}
    </div>
  );
}

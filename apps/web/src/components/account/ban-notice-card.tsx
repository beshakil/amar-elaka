import { getFormatter, getTranslations } from 'next-intl/server';
import { noticeLines } from '@/lib/account/notice';
import type { BanNotice } from '@/lib/api/schemas';

/** One ban (ADR 063): why, how long, which area, the reference, and where its appeal stands. */
export async function BanNoticeCard({
  notice,
  children,
}: {
  notice: BanNotice;
  children?: React.ReactNode;
}) {
  const [t, format] = await Promise.all([getTranslations('account'), getFormatter()]);
  const lines = noticeLines(notice);
  return (
    <article className="space-y-2 rounded-lg border p-4" data-testid={`ban-${lines.reference}`}>
      <h2 className="font-semibold text-destructive">{t(lines.severityKey)}</h2>
      <p className="text-sm text-muted-foreground">{t(`explain.${notice.severity}`)}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-medium">{t('why')}</dt>
        <dd>{t(lines.reasonKey)}</dd>
        <dt className="font-medium">{t('howLong')}</dt>
        <dd>
          {lines.until
            ? t('until', { date: format.dateTime(new Date(lines.until), { dateStyle: 'long' }) })
            : t('permanent')}
        </dd>
        <dt className="font-medium">{t('where')}</dt>
        <dd>{lines.area ? t('inArea', { area: lines.area }) : t('everywhere')}</dd>
        <dt className="font-medium">{t('reference')}</dt>
        <dd className="font-mono">{lines.reference}</dd>
      </dl>
      {lines.appeal ? (
        <p className="text-sm font-medium" data-testid="ban-appeal-status">
          {t(lines.appeal.statusKey, { reference: lines.appeal.reference })}
        </p>
      ) : (
        lines.canAppeal && children
      )}
    </article>
  );
}

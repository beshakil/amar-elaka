import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ApiError, apiFetch } from '@/lib/api/fetch';
import { verificationDetailSchema, type VerificationDetail } from '@/lib/api/schemas';
import { requireGrant } from '@/lib/auth/guards';
import { ModerationTabs } from '../../moderation-tabs';
import { DecisionPanel } from './decision-panel';

/**
 * One verification request (ADR 062): the evidence side by side — the selfie
 * and the shop front as images, the trade licence as an image or a PDF —
 * each through a signed link that expires in minutes (reload for fresh
 * ones), never a public address; the subject, the NID's last 3 digits and a
 * duplicate warning, their earlier requests; and the decision.
 */
export default async function VerificationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const viewer = await requireGrant({ module: 'verifications', action: 'approve' });
  let detail: VerificationDetail;
  try {
    detail = await apiFetch({
      path: `/verifications/${id}`,
      schema: verificationDetailSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const [t, format] = await Promise.all([getTranslations('verification'), getFormatter()]);
  const open = detail.status === 'submitted' || detail.status === 'in_review';
  return (
    <>
      <ModerationTabs active="verifications" />
      <Link
        href={'/moderation/verifications'}
        className="text-sm text-muted-foreground hover:underline"
      >
        {t('back')}
      </Link>
      <div className="mt-2 mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{detail.subjectName ?? t('unnamed')}</h1>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">{t(`level.${detail.level}`)}</span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">{t(`status.${detail.status}`)}</span>
      </div>

      <dl className="mb-6 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        {detail.nidLast3 && (
          <div>
            <dt className="text-muted-foreground">{t('nid')}</dt>
            <dd>{t('nidLast3', { digits: detail.nidLast3 })}</dd>
          </div>
        )}
        {detail.ownerLevel && (
          <div>
            <dt className="text-muted-foreground">{t('ownerLevel')}</dt>
            <dd>{t(`ownerLevels.${detail.ownerLevel}`)}</dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">{t('submitted')}</dt>
          <dd>
            {format.dateTime(new Date(detail.createdAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </dd>
        </div>
      </dl>
      {detail.nidDuplicate && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {t('duplicateNidWarning')}
        </p>
      )}

      <section aria-label={t('evidence')} className="mb-6">
        <h2 className="mb-2 font-medium">{t('evidence')}</h2>
        {detail.documentsPurged ? (
          <p className="text-sm text-muted-foreground">{t('purged')}</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              {t('linksExpire', {
                minutes: Math.max(1, Math.round(detail.urlExpiresInSeconds / 60)),
              })}
            </p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="evidence-grid">
              {detail.evidence.map((e) => (
                <figure
                  key={e.kind}
                  className="overflow-hidden rounded-md border bg-card"
                  data-testid={`evidence-${e.kind}`}
                >
                  <figcaption className="border-b px-3 py-2 text-sm font-medium">
                    {t(`kind.${e.kind}`)}
                  </figcaption>
                  {e.purged || !e.url ? (
                    <p className="p-6 text-sm text-muted-foreground">{t('purged')}</p>
                  ) : e.mimeType === 'application/pdf' ? (
                    <div className="space-y-2 p-3">
                      <object
                        data={e.url}
                        type="application/pdf"
                        className="h-96 w-full"
                        aria-label={t(`kind.${e.kind}`)}
                      >
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm underline"
                        >
                          {t('openPdf')}
                        </a>
                      </object>
                    </div>
                  ) : (
                    <a href={e.url} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL, never cached */}
                      <img
                        src={e.previewUrl ?? e.url}
                        alt={t(`kind.${e.kind}`)}
                        className="h-96 w-full object-contain bg-muted"
                      />
                    </a>
                  )}
                </figure>
              ))}
            </div>
          </>
        )}
      </section>

      {detail.history.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 font-medium">{t('history')}</h2>
          <ul className="text-sm">
            {detail.history.map((h) => (
              <li key={h.id}>
                {format.dateTime(new Date(h.createdAt), { dateStyle: 'medium' })} —{' '}
                {t(`status.${h.status}`)}
                {h.rejectionReason ? ` (${t(`rejection.${h.rejectionReason}`)})` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {open ? (
        <DecisionPanel
          id={detail.id}
          level={detail.level}
          visitRequested={detail.visitStatus === 'requested'}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('decided')}</p>
      )}
    </>
  );
}

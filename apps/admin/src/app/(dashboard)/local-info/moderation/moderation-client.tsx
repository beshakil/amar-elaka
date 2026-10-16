'use client';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { InfoModerationItem } from '@/lib/api/schemas';
import { decideInfoItem, type InfoDecisionInput } from '../actions';

const REASONS = [
  'false_information',
  'privacy_risk',
  'disrespectful',
  'spam',
  'harassment',
  'policy_violation',
  'illegal_content',
] as const satisfies readonly InfoDecisionInput['reasonCode'][];

// Mirrors the API's minimum reason length (it checks again).
const REASON_MIN = 3;

export function ModerationClient({ items }: { items: InfoModerationItem[] }) {
  const t = useTranslations('localInfo.moderation');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const [refusing, setRefusing] = useState<{
    id: string;
    reasonCode: (typeof REASONS)[number];
    reasonText: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(item: InfoModerationItem, input: InfoDecisionInput) {
    setBusy(true);
    setError(null);
    const result = await decideInfoItem(item.kind, item.id, input);
    setBusy(false);
    if (result.ok) {
      setRefusing(null);
      router.refresh();
    } else setError(tError(result.messageKey));
  }

  if (items.length === 0) return <p className="text-muted-foreground">{t('empty')}</p>;
  return (
    <>
      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {items.map((item) => {
          const fields = item.templateFields as { deceasedName?: string };
          // Waiting: approve or reject. Live and reported: keep or remove.
          const waiting = item.status === 'pending_review';
          const refusal = waiting ? 'reject' : 'remove';
          return (
            <li key={`${item.kind}-${item.id}`} className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                {t(`kinds.${item.kind}`)} ·{' '}
                {t.has(`types.${item.type}`) ? t(`types.${item.type}`) : item.type}
                {item.template ? ` · ${t(`templates.${item.template}`)}` : ''}
              </p>
              <p className="font-medium">{item.title}</p>
              {fields.deceasedName ? <p className="text-sm">{fields.deceasedName}</p> : null}
              {item.body ? <p className="mt-1 whitespace-pre-line text-sm">{item.body}</p> : null}
              {item.photos.length > 0 && (
                <div className="mt-2 flex gap-2 overflow-x-auto">
                  {item.photos.map((p) =>
                    p.kind === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a moderation preview
                      <img key={p.id} src={p.url} alt="" className="size-20 rounded object-cover" />
                    ) : null,
                  )}
                </div>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {item.authorName ?? t('unknownAuthor')} ·{' '}
                {format.dateTime(new Date(item.createdAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
                {item.openReports > 0 ? ` · ${t('reports', { count: item.openReports })}` : ''}
              </p>
              {refusing?.id === item.id ? (
                <div className="mt-2 grid gap-2">
                  <select
                    aria-label={t('reason')}
                    className="h-10 rounded-md border bg-background px-2"
                    value={refusing.reasonCode}
                    onChange={(e) =>
                      setRefusing({
                        ...refusing,
                        reasonCode: e.target.value as (typeof REASONS)[number],
                      })
                    }
                  >
                    {REASONS.map((r) => (
                      <option key={r} value={r}>
                        {t(`reasons.${r}`)}
                      </option>
                    ))}
                  </select>
                  <Input
                    aria-label={t('reasonText')}
                    placeholder={t('reasonText')}
                    value={refusing.reasonText}
                    onChange={(e) => setRefusing({ ...refusing, reasonText: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      disabled={busy || refusing.reasonText.trim().length < REASON_MIN}
                      onClick={() =>
                        void decide(item, {
                          decision: refusal,
                          reasonCode: refusing.reasonCode,
                          reasonText: refusing.reasonText.trim(),
                        })
                      }
                    >
                      {t(refusal)}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRefusing(null)}>
                      {t('cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void decide(item, { decision: 'approve', reasonCode: 'meets_guidelines' })
                    }
                  >
                    {waiting ? t('approve') : t('keep')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    onClick={() =>
                      setRefusing({ id: item.id, reasonCode: 'false_information', reasonText: '' })
                    }
                  >
                    {waiting ? t('refuse') : t('remove')}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CrudPage } from '@/components/crud/crud-page';
import { dataTableColumnHelper } from '@/components/data-table/data-table';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ActionResult } from '@/lib/action-result';
import type { ModerationQueueItem } from '@/lib/api/schemas';
import { approvePost, hardRemovePost, rejectPost, removePost } from './actions';
import { QUEUE_REASONS, TAKEDOWN_REASONS, type TakedownReason } from './reasons';

type Decision = 'reject' | 'remove' | 'hardRemove';

/**
 * The moderation queue on CrudPage: the tenant's open items, oldest first,
 * with approve / reject / remove per row (hard removal only for tenant
 * admins). Nothing is created or edited here, so CrudPage shows no forms.
 */
export function ModerationClient({
  items,
  reason,
  canHardRemove,
}: {
  items: ModerationQueueItem[];
  reason: string | null;
  canHardRemove: boolean;
}) {
  const t = useTranslations('moderation');
  const tError = useTranslations('apiError');
  const router = useRouter();
  const [pending, setPending] = useState<{ item: ModerationQueueItem; decision: Decision } | null>(
    null,
  );

  function done(result: ActionResult, success: string) {
    if (result.ok) {
      toast.success(success);
      router.refresh();
    } else {
      toast.error(tError(result.messageKey));
    }
  }

  const columns = useMemo(() => {
    const helper = dataTableColumnHelper<ModerationQueueItem>();
    return helper.columns([
      helper.accessor('title', { header: t('postTitle') }),
      helper.accessor((item) => item.category.name.bn, { id: 'category', header: t('category') }),
      helper.accessor((item) => item.reasons.map((r) => t(`reason.${r}`)).join(', '), {
        id: 'reasons',
        header: t('reasons'),
      }),
      helper.accessor((item) => item.authorTrustScore ?? '—', { id: 'trust', header: t('trust') }),
      helper.accessor((item) => t(`status.${item.postStatus}`), {
        id: 'status',
        header: t('postStatus'),
      }),
      helper.accessor('ageHours', {
        header: t('age'),
        cell: ({ getValue }) => t('ageHours', { hours: getValue() }),
      }),
    ]);
  }, [t]);

  return (
    <>
      <nav aria-label={t('filter')} className="mb-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={reason === null ? 'primary' : 'outline'}
          onClick={() => router.push('/moderation')}
        >
          {t('all')}
        </Button>
        {QUEUE_REASONS.map((code) => (
          <Button
            key={code}
            size="sm"
            variant={reason === code ? 'primary' : 'outline'}
            onClick={() => router.push(`/moderation?reason=${code}`)}
          >
            {t(`reason.${code}`)}
          </Button>
        ))}
      </nav>

      <CrudPage
        title={t('pageTitle')}
        description={t('description')}
        columns={columns}
        rows={items}
        getRowId={(item) => item.postId}
        exportFilename="moderation-queue"
        renderRowActions={(item) => (
          <>
            <Button
              size="sm"
              onClick={async () => done(await approvePost(item.postId), t('approved'))}
            >
              {t('approve')}
            </Button>
            {item.postStatus === 'pending' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPending({ item, decision: 'reject' })}
              >
                {t('reject')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPending({ item, decision: 'remove' })}
              >
                {t('remove')}
              </Button>
            )}
            {canHardRemove ? (
              <Button
                size="sm"
                variant="outline"
                className="border-destructive text-destructive"
                onClick={() => setPending({ item, decision: 'hardRemove' })}
              >
                {t('hardRemove')}
              </Button>
            ) : null}
          </>
        )}
      />

      {pending ? (
        <DecisionDialog
          item={pending.item}
          decision={pending.decision}
          onClose={() => setPending(null)}
          onSubmit={async (input) => {
            const id = pending.item.postId;
            const result =
              pending.decision === 'reject'
                ? await rejectPost(id, input)
                : pending.decision === 'remove'
                  ? await removePost(id, input)
                  : await hardRemovePost(id, {
                      reasonCode: input.reasonCode,
                      reasonText: input.reasonText ?? '',
                      evidenceRefs: input.evidenceRefs,
                    });
            done(result, t(`${pending.decision}Done`));
            if (result.ok) setPending(null);
          }}
        />
      ) : null}
    </>
  );
}

function DecisionDialog({
  item,
  decision,
  onClose,
  onSubmit,
}: {
  item: ModerationQueueItem;
  decision: Decision;
  onClose: () => void;
  onSubmit: (input: {
    reasonCode: TakedownReason;
    reasonText?: string;
    evidenceRefs: string[];
  }) => Promise<void>;
}) {
  const t = useTranslations('moderation');
  const [reasonCode, setReasonCode] = useState<TakedownReason>('policy_violation');
  const [reasonText, setReasonText] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const hard = decision === 'hardRemove';
  const evidenceRefs = evidence
    .split(',')
    .map((ref) => ref.trim())
    .filter((ref) => ref !== '');
  const valid = !hard || (reasonText.trim() !== '' && evidenceRefs.length > 0);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent closeLabel={t('cancel')}>
        <DialogTitle>{t(`${decision}Title`)}</DialogTitle>
        <DialogDescription>{item.title}</DialogDescription>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await onSubmit({
                reasonCode,
                ...(reasonText.trim() ? { reasonText: reasonText.trim() } : {}),
                evidenceRefs,
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="reasonCode">{t('reasonCode')}</Label>
            <select
              id="reasonCode"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value as TakedownReason)}
            >
              {TAKEDOWN_REASONS.map((code) => (
                <option key={code} value={code}>
                  {t(`takedown.${code}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="reasonText">{hard ? t('reasonTextRequired') : t('reasonText')}</Label>
            <Input
              id="reasonText"
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
            />
          </div>
          {hard ? (
            <div className="space-y-1">
              <Label htmlFor="evidence">{t('evidence')}</Label>
              <Input
                id="evidence"
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('hardRemoveWarning')}</p>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              className={hard ? 'bg-destructive text-destructive-foreground' : undefined}
              disabled={busy || !valid}
            >
              {t(decision)}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

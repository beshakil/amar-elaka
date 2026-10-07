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
import type {
  DuplicateItem,
  PlaceClaimItem,
  PlaceReportItem,
  PlaceReviewItem,
  PlaceSuggestionItem,
  SuggestionChanges,
} from '@/lib/api/schemas';
import { TAKEDOWN_REASONS } from '../reasons';
import {
  approveClaim,
  approvePlace,
  approveSuggestion,
  decideReports,
  dismissDuplicate,
  mergeDuplicate,
  rejectClaim,
  rejectPlace,
  rejectSuggestion,
} from './actions';
import {
  CLAIM_REJECT_REASONS,
  PLACE_TABS,
  SUGGESTION_REJECT_REASONS,
  type PlaceTab,
  type ReportDecision,
} from './reasons';

/** A dialog asking for a reason before a decision is sent. */
interface PendingReason {
  title: string;
  subject: string;
  reasons: readonly string[];
  initial: string;
  submit: (input: { reasonCode: string; reasonText?: string }) => Promise<ActionResult>;
  done: string;
}

/**
 * The Places tab: five queues on CrudPage, one per sub-tab, each with its own
 * decisions. Every decision is one API call that writes its
 * moderation_actions row server side; the page reloads after it.
 */
export function PlacesClient({
  tab,
  fresh,
  claims,
  suggestions,
  duplicates,
  reports,
}: {
  tab: PlaceTab;
  fresh: PlaceReviewItem[];
  claims: PlaceClaimItem[];
  suggestions: PlaceSuggestionItem[];
  duplicates: DuplicateItem[];
  reports: PlaceReportItem[];
}) {
  const t = useTranslations('moderation.places');
  const tTakedown = useTranslations('moderation.takedown');
  const tError = useTranslations('apiError');
  const router = useRouter();
  const [pending, setPending] = useState<PendingReason | null>(null);

  const counts: Record<PlaceTab, number> = {
    new: fresh.length,
    claims: claims.length,
    suggestions: suggestions.length,
    duplicates: duplicates.length,
    reports: reports.length,
  };

  function done(result: ActionResult, success: string): boolean {
    if (result.ok) {
      toast.success(success);
      router.refresh();
    } else {
      toast.error(tError(result.messageKey));
    }
    return result.ok;
  }

  const reasonLabel = (code: string) =>
    (TAKEDOWN_REASONS as readonly string[]).includes(code) ? tTakedown(code) : t(`reason.${code}`);

  return (
    <>
      <nav aria-label={t('tabsLabel')} className="mb-4 flex flex-wrap gap-2">
        {PLACE_TABS.map((key) => (
          <Button
            key={key}
            size="sm"
            variant={tab === key ? 'primary' : 'outline'}
            onClick={() => router.push(`/moderation/places?tab=${key}`)}
          >
            {t(`tab.${key}`, { count: counts[key] })}
          </Button>
        ))}
      </nav>

      {tab === 'new' ? (
        <NewPlaces
          items={fresh}
          onApprove={async (item) => done(await approvePlace(item.id), t('approvedPlace'))}
          onReject={(item) =>
            setPending({
              title: t('rejectPlaceTitle'),
              subject: item.nameBn,
              reasons: TAKEDOWN_REASONS,
              initial: 'policy_violation',
              submit: (input) =>
                rejectPlace(item.id, {
                  reasonCode: input.reasonCode as (typeof TAKEDOWN_REASONS)[number],
                  reasonText: input.reasonText,
                }),
              done: t('rejectedPlace'),
            })
          }
        />
      ) : null}

      {tab === 'claims' ? (
        <Claims
          items={claims}
          onApprove={async (item) => done(await approveClaim(item.id), t('approvedClaim'))}
          onReject={(item) =>
            setPending({
              title: t('rejectClaimTitle'),
              subject: item.place.nameBn,
              reasons: CLAIM_REJECT_REASONS,
              initial: 'place_already_claimed',
              submit: (input) =>
                rejectClaim(item.id, {
                  reasonCode: input.reasonCode as (typeof CLAIM_REJECT_REASONS)[number],
                  reasonText: input.reasonText,
                }),
              done: t('rejectedClaim'),
            })
          }
        />
      ) : null}

      {tab === 'suggestions' ? (
        <Suggestions
          items={suggestions}
          onApprove={async (item) =>
            done(await approveSuggestion(item.id), t('approvedSuggestion'))
          }
          onReject={(item) =>
            setPending({
              title: t('rejectSuggestionTitle'),
              subject: item.placeNameBn,
              reasons: SUGGESTION_REJECT_REASONS,
              initial: 'suggestion_incorrect',
              submit: (input) =>
                rejectSuggestion(item.id, {
                  reasonCode: input.reasonCode as (typeof SUGGESTION_REJECT_REASONS)[number],
                  reasonText: input.reasonText,
                }),
              done: t('rejectedSuggestion'),
            })
          }
        />
      ) : null}

      {tab === 'duplicates' ? (
        <Duplicates
          items={duplicates}
          onMerge={async (item) =>
            done(await mergeDuplicate(item.entity.id, item.candidate.id), t('merged'))
          }
          onDismiss={async (item) => done(await dismissDuplicate(item.id), t('dismissedPair'))}
        />
      ) : null}

      {tab === 'reports' ? (
        <Reports
          items={reports}
          reasonLabel={(code) => t(`reportReason.${code}`)}
          onDecide={async (item, decision) =>
            done(await decideReports(item.placeId, { decision }), t(`decided.${decision}`))
          }
          onUnpublish={(item) =>
            setPending({
              title: t('unpublishTitle'),
              subject: item.nameBn,
              reasons: TAKEDOWN_REASONS,
              initial: 'policy_violation',
              submit: (input) =>
                decideReports(item.placeId, {
                  decision: 'unpublish',
                  reasonCode: input.reasonCode as (typeof TAKEDOWN_REASONS)[number],
                  reasonText: input.reasonText,
                }),
              done: t('decided.unpublish'),
            })
          }
        />
      ) : null}

      {pending ? (
        <ReasonDialog
          pending={pending}
          reasonLabel={reasonLabel}
          onClose={() => setPending(null)}
          onSubmit={async (input) => {
            if (done(await pending.submit(input), pending.done)) setPending(null);
          }}
        />
      ) : null}
    </>
  );
}

// ---- the five queues ----------------------------------------------------------

function useAge() {
  const t = useTranslations('moderation');
  return (iso: string) =>
    t('ageHours', { hours: Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / HOUR_MS)) });
}

// One hour in milliseconds (display only).
const HOUR_MS = 3_600_000;
// Coordinates to five decimals: about a metre.
const COORD_DECIMALS = 5;
const coords = (p: { lat: number; lng: number }) =>
  `${p.lat.toFixed(COORD_DECIMALS)}, ${p.lng.toFixed(COORD_DECIMALS)}`;

function NewPlaces({
  items,
  onApprove,
  onReject,
}: {
  items: PlaceReviewItem[];
  onApprove: (item: PlaceReviewItem) => void;
  onReject: (item: PlaceReviewItem) => void;
}) {
  const t = useTranslations('moderation.places');
  const age = useAge();
  const columns = useMemo(() => {
    const helper = dataTableColumnHelper<PlaceReviewItem>();
    return helper.columns([
      helper.accessor('nameBn', { header: t('name') }),
      helper.accessor((item) => coords(item.location), { id: 'location', header: t('location') }),
      helper.accessor((item) => (item.outsideBoundary ? t('outside') : '—'), {
        id: 'boundary',
        header: t('boundary'),
      }),
      helper.accessor('photoCount', { header: t('photos') }),
      helper.accessor((item) => age(item.queuedAt), { id: 'age', header: t('age') }),
    ]);
  }, [t, age]);
  return (
    <CrudPage
      title={t('tab.new', { count: items.length })}
      description={t('newDescription')}
      columns={columns}
      rows={items}
      getRowId={(item) => item.id}
      exportFilename="new-places"
      renderRowActions={(item) => (
        <>
          <Button size="sm" onClick={() => onApprove(item)}>
            {t('approve')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onReject(item)}>
            {t('reject')}
          </Button>
        </>
      )}
    />
  );
}

function Claims({
  items,
  onApprove,
  onReject,
}: {
  items: PlaceClaimItem[];
  onApprove: (item: PlaceClaimItem) => void;
  onReject: (item: PlaceClaimItem) => void;
}) {
  const t = useTranslations('moderation.places');
  const age = useAge();
  const columns = useMemo(() => {
    const helper = dataTableColumnHelper<PlaceClaimItem>();
    return helper.columns([
      helper.accessor((item) => item.place.nameBn, { id: 'place', header: t('name') }),
      helper.accessor((item) => item.evidence.map((e) => t(`evidence.${e}`)).join(', '), {
        id: 'evidence',
        header: t('evidenceHeader'),
      }),
      helper.accessor((item) => item.otpVerifiedPhone ?? '—', { id: 'otp', header: t('otp') }),
      helper.accessor('competingClaims', { header: t('competing') }),
      helper.accessor((item) => item.note ?? '—', { id: 'note', header: t('note') }),
      helper.accessor((item) => age(item.queuedAt), { id: 'age', header: t('age') }),
    ]);
  }, [t, age]);
  return (
    <CrudPage
      title={t('tab.claims', { count: items.length })}
      description={t('claimsDescription')}
      columns={columns}
      rows={items}
      getRowId={(item) => item.id}
      exportFilename="place-claims"
      renderRowActions={(item) => (
        <>
          <Button size="sm" onClick={() => onApprove(item)}>
            {t('approve')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onReject(item)}>
            {t('reject')}
          </Button>
        </>
      )}
    />
  );
}

function Suggestions({
  items,
  onApprove,
  onReject,
}: {
  items: PlaceSuggestionItem[];
  onApprove: (item: PlaceSuggestionItem) => void;
  onReject: (item: PlaceSuggestionItem) => void;
}) {
  const t = useTranslations('moderation.places');
  const age = useAge();
  const columns = useMemo(() => {
    const helper = dataTableColumnHelper<PlaceSuggestionItem>();
    return helper.columns([
      helper.accessor('placeNameBn', { header: t('name') }),
      helper.accessor((item) => item.id, {
        id: 'changes',
        header: t('changes'),
        cell: ({ row }) => (
          <ChangeList changes={row.original.changes} current={row.original.current} />
        ),
      }),
      helper.accessor((item) => item.note ?? '—', { id: 'note', header: t('note') }),
      helper.accessor('suggesterTrustScore', { header: t('trust') }),
      helper.accessor((item) => age(item.createdAt), { id: 'age', header: t('age') }),
    ]);
  }, [t, age]);
  return (
    <CrudPage
      title={t('tab.suggestions', { count: items.length })}
      description={t('suggestionsDescription')}
      columns={columns}
      rows={items}
      getRowId={(item) => item.id}
      exportFilename="place-suggestions"
      renderRowActions={(item) => (
        <>
          <Button size="sm" onClick={() => onApprove(item)}>
            {t('approve')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onReject(item)}>
            {t('reject')}
          </Button>
        </>
      )}
    />
  );
}

// Mean Earth radius in metres (display of how far a pin moves).
const EARTH_RADIUS_M = 6_371_008.8;

function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "now → suggested", per field. */
function ChangeList({
  changes,
  current,
}: {
  changes: SuggestionChanges;
  current: SuggestionChanges;
}) {
  const t = useTranslations('moderation.places');
  const hours = (list: SuggestionChanges['hours']) =>
    list && list.length > 0
      ? list.map((h) => `${t(`day.${h.day}`)} ${h.opens}–${h.closes}`).join(', ')
      : t('noHours');
  return (
    <ul className="space-y-1 text-sm">
      {changes.location ? (
        <li>
          {t('field.location')}: {coords(changes.location)}
          {current.location
            ? ` (${t('moved', { metres: Math.round(metresBetween(current.location, changes.location)) })})`
            : null}
        </li>
      ) : null}
      {changes.phones ? (
        <li>
          {t('field.phones')}: {(current.phones ?? []).join(', ') || '—'} →{' '}
          {changes.phones.join(', ')}
        </li>
      ) : null}
      {changes.hours ? (
        <li>
          {t('field.hours')}: {hours(current.hours)} → {hours(changes.hours)}
        </li>
      ) : null}
    </ul>
  );
}

function Duplicates({
  items,
  onMerge,
  onDismiss,
}: {
  items: DuplicateItem[];
  onMerge: (item: DuplicateItem) => void;
  onDismiss: (item: DuplicateItem) => void;
}) {
  const t = useTranslations('moderation.places');
  const age = useAge();
  const columns = useMemo(() => {
    const helper = dataTableColumnHelper<DuplicateItem>();
    return helper.columns([
      helper.accessor((item) => item.entity.nameBn ?? '—', { id: 'entity', header: t('flagged') }),
      helper.accessor((item) => item.candidate.nameBn ?? t('neighbourArea'), {
        id: 'candidate',
        header: t('resembles'),
      }),
      helper.accessor((item) => `${t(`class.${item.classification}`)} · ${item.score.toFixed(2)}`, {
        id: 'score',
        header: t('score'),
      }),
      helper.accessor((item) => t(`source.${item.source}`), { id: 'source', header: t('source') }),
      helper.accessor((item) => age(item.createdAt), { id: 'age', header: t('age') }),
    ]);
  }, [t, age]);
  return (
    <CrudPage
      title={t('tab.duplicates', { count: items.length })}
      description={t('duplicatesDescription')}
      columns={columns}
      rows={items}
      getRowId={(item) => item.id}
      exportFilename="duplicate-places"
      renderRowActions={(item) => (
        <>
          {item.entityType === 'place' ? (
            <Button size="sm" onClick={() => onMerge(item)}>
              {t('merge')}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => onDismiss(item)}>
            {t('notDuplicate')}
          </Button>
        </>
      )}
    />
  );
}

function Reports({
  items,
  reasonLabel,
  onDecide,
  onUnpublish,
}: {
  items: PlaceReportItem[];
  reasonLabel: (code: string) => string;
  onDecide: (item: PlaceReportItem, decision: Exclude<ReportDecision, 'unpublish'>) => void;
  onUnpublish: (item: PlaceReportItem) => void;
}) {
  const t = useTranslations('moderation.places');
  const age = useAge();
  const columns = useMemo(() => {
    const helper = dataTableColumnHelper<PlaceReportItem>();
    return helper.columns([
      helper.accessor('nameBn', {
        header: t('name'),
        cell: ({ row }) => (
          <span>
            {row.original.nameBn}
            {row.original.possiblyClosed ? (
              <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                {t('possiblyClosed')}
              </span>
            ) : null}
          </span>
        ),
      }),
      helper.accessor(
        (item) =>
          Object.entries(item.reasons)
            .map(([code, count]) => `${reasonLabel(code)} (${count})`)
            .join(', '),
        { id: 'reasons', header: t('reasons') },
      ),
      helper.accessor('reporterCount', { header: t('reporters') }),
      helper.accessor((item) => item.notes.join(' · ') || '—', { id: 'notes', header: t('notes') }),
      helper.accessor((item) => age(item.firstReportedAt), { id: 'age', header: t('age') }),
    ]);
  }, [t, age, reasonLabel]);
  return (
    <CrudPage
      title={t('tab.reports', { count: items.length })}
      description={t('reportsDescription')}
      columns={columns}
      rows={items}
      getRowId={(item) => item.placeId}
      exportFilename="place-reports"
      renderRowActions={(item) => {
        const closedReports = (item.reasons.closed_permanently ?? 0) > 0;
        return (
          <>
            {item.possiblyClosed || closedReports ? (
              <>
                <Button size="sm" onClick={() => onDecide(item, 'confirm_closed')}>
                  {t('decision.confirm_closed')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onDecide(item, 'clear_closed_flag')}
                >
                  {t('decision.clear_closed_flag')}
                </Button>
              </>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => onDecide(item, 'resolved')}>
              {t('decision.resolved')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDecide(item, 'dismiss')}>
              {t('decision.dismiss')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-destructive text-destructive"
              onClick={() => onUnpublish(item)}
            >
              {t('decision.unpublish')}
            </Button>
          </>
        );
      }}
    />
  );
}

// ---- the reason dialog -----------------------------------------------------------

function ReasonDialog({
  pending,
  reasonLabel,
  onClose,
  onSubmit,
}: {
  pending: PendingReason;
  reasonLabel: (code: string) => string;
  onClose: () => void;
  onSubmit: (input: { reasonCode: string; reasonText?: string }) => Promise<void>;
}) {
  const t = useTranslations('moderation');
  const [reasonCode, setReasonCode] = useState(pending.initial);
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent closeLabel={t('cancel')}>
        <DialogTitle>{pending.title}</DialogTitle>
        <DialogDescription>{pending.subject}</DialogDescription>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await onSubmit({
                reasonCode,
                ...(reasonText.trim() ? { reasonText: reasonText.trim() } : {}),
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="placeReasonCode">{t('reasonCode')}</Label>
            <select
              id="placeReasonCode"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value)}
            >
              {pending.reasons.map((code) => (
                <option key={code} value={code}>
                  {reasonLabel(code)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="placeReasonText">{t('reasonText')}</Label>
            <Input
              id="placeReasonText"
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {t('confirmDecision')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

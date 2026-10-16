'use client';

import type { Route } from 'next';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AgentSubmission, AgentSubmissionDay, MapConfig } from '@/lib/api/schemas';
import { TAKEDOWN_REASONS } from '../../moderation/reasons';
import { SUGGESTION_REJECT_REASONS } from '../../moderation/places/reasons';
import {
  approvePlace,
  approveSuggestion,
  rejectPlace,
  rejectSuggestion,
} from '../../moderation/places/actions';
import { agentColour } from './submissions-map';

// MapLibre touches `window`: client only.
const SubmissionsMap = dynamic(() => import('./submissions-map').then((m) => m.SubmissionsMap), {
  ssr: false,
  loading: () => <div className="h-[45vh] w-full animate-pulse rounded-lg bg-muted" />,
});

// Mirrors the API's minimum reason length for a rejection note (it checks again).
const NOTE_MIN = 3;

export function SubmissionsClient({
  day,
  agents,
  agentId,
  config,
}: {
  day: AgentSubmissionDay;
  agents: { id: string; label: string }[];
  agentId: string | null;
  config: MapConfig | null;
}) {
  const t = useTranslations('agents');
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const agentIds = agents.map((a) => a.id);
  const pending = day.items.filter((s) => s.reviewStatus === 'pending' && s.kind !== 'verify_shop');

  const go = (date: string, agent: string | null) => {
    const q = new URLSearchParams({ date, ...(agent ? { agentId: agent } : {}) });
    router.push(`/agents/submissions?${q.toString()}` as Route);
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label htmlFor="s-date">{t('date')}</Label>
          <Input
            id="s-date"
            type="date"
            value={day.date}
            onChange={(e) => e.target.value && go(e.target.value, agentId)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="s-agent">{t('agent')}</Label>
          <select
            id="s-agent"
            className="h-10 rounded-md border bg-background px-2"
            value={agentId ?? ''}
            onChange={(e) => go(day.date, e.target.value || null)}
          >
            <option value="">{t('allAgents')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('dayCounts', { total: day.items.length, pending: pending.length })}
        </p>
      </div>

      {day.items.length === 0 ? (
        <p className="text-muted-foreground">{t('noSubmissions')}</p>
      ) : (
        <>
          {config ? (
            <SubmissionsMap
              config={config}
              items={day.items}
              agentIds={agentIds}
              label={t('mapLabel')}
              onSelect={setSelected}
            />
          ) : null}
          <ul className="mt-4 grid gap-3 md:grid-cols-2" data-testid="agent-submissions">
            {day.items.map((s) => (
              <SubmissionCard
                key={s.id}
                item={s}
                colour={agentColour(agentIds, s.agentId)}
                selected={selected === s.id}
              />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function SubmissionCard({
  item,
  colour,
  selected,
}: {
  item: AgentSubmission;
  colour: string;
  selected: boolean;
}) {
  const t = useTranslations('agents');
  const tMod = useTranslations('moderation');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<string>(
    item.kind === 'update_info' ? 'suggestion_incorrect' : 'spam',
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ ok: true } | { ok: false; messageKey: string }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(tError(result.messageKey));
  }

  const reviewable = item.reviewStatus === 'pending' && item.kind !== 'verify_shop';
  const approve = () =>
    item.kind === 'update_info' && item.placeEditSuggestionId
      ? approveSuggestion(item.placeEditSuggestionId)
      : approvePlace(item.placeId!);
  const reject = () =>
    item.kind === 'update_info' && item.placeEditSuggestionId
      ? rejectSuggestion(item.placeEditSuggestionId, {
          reasonCode: reason as (typeof SUGGESTION_REJECT_REASONS)[number],
          reasonText: note.trim(),
        })
      : rejectPlace(item.placeId!, {
          reasonCode: reason as (typeof TAKEDOWN_REASONS)[number],
          reasonText: note.trim(),
        });
  const reasons = item.kind === 'update_info' ? SUGGESTION_REJECT_REASONS : TAKEDOWN_REASONS;

  return (
    <li
      id={`submission-${item.id}`}
      className={`rounded-md border p-3 ${selected ? 'ring-2 ring-primary' : ''}`}
      style={{ borderLeft: `6px solid ${colour}` }}
    >
      <p className="text-xs text-muted-foreground">
        {item.agentCode} · {t(`kinds.${item.kind}`)} ·{' '}
        {format.dateTime(new Date(item.capturedAt), { timeStyle: 'short' })} · ±
        {Math.round(item.accuracyM)} m
      </p>
      <p className="font-medium">{item.name ?? '—'}</p>
      {item.notes ? <p className="text-sm">{item.notes}</p> : null}
      {item.photos.length > 0 && (
        <div className="mt-2 flex gap-2 overflow-x-auto">
          {item.photos.map((p) =>
            p.url ? (
              // eslint-disable-next-line @next/next/no-img-element -- a review preview
              <img key={p.id} src={p.url} alt="" className="size-24 rounded object-cover" />
            ) : null,
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        <span className="rounded bg-muted px-2 py-0.5 text-xs">
          {t(`review.${item.reviewStatus}`)}
        </span>
        {item.phoneCheck !== 'none' && (
          <span className="rounded bg-muted px-2 py-0.5 text-xs">
            {t(`phoneCheck.${item.phoneCheck}`)}
          </span>
        )}
        {item.fraudFlags.map((f) => (
          <span
            key={f}
            className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          >
            {t(`flags.${f}`)}
          </span>
        ))}
      </div>
      {item.reviewStatus === 'rejected' && item.reasonCode ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {tMod.has(`takedown.${item.reasonCode}`)
            ? tMod(`takedown.${item.reasonCode}`)
            : item.reasonCode}
        </p>
      ) : null}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {reviewable &&
        (rejecting ? (
          <div className="mt-2 grid gap-2">
            <select
              aria-label={t('rejectReason')}
              className="h-10 rounded-md border bg-background px-2"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {reasons.map((r) => (
                <option key={r} value={r}>
                  {tMod.has(`takedown.${r}`) ? tMod(`takedown.${r}`) : t(`rejectReasons.${r}`)}
                </option>
              ))}
            </select>
            <Input
              aria-label={t('rejectNote')}
              placeholder={t('rejectNote')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={busy || note.trim().length < NOTE_MIN}
                onClick={() => void run(reject)}
              >
                {t('reject')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                {t('cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void run(approve)}>
              {t('approve')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => setRejecting(true)}
            >
              {t('reject')}
            </Button>
          </div>
        ))}
    </li>
  );
}

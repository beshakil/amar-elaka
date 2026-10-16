'use client';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { RouteDetail } from '@/lib/api/schemas';
import { deleteRoute, saveRoute, verifyRoute, type RouteInput } from '../actions';
import {
  asciiDigits,
  formatDepartures,
  formatStops,
  parseDepartures,
  parsePoint,
  parseStops,
} from '../engine-form';

const MODES = [
  'bus',
  'train',
  'launch',
  'ferry',
  'cng_stand',
  'cng',
  'auto_rickshaw',
  'leguna',
  'microbus',
] as const;

interface Form {
  mode: RouteInput['mode'];
  nameBn: string;
  operatorName: string;
  originName: string;
  destinationName: string;
  originPoint: string;
  destinationPoint: string;
  duration: string;
  fareMin: string;
  fareMax: string;
  phones: string;
  notes: string;
  stops: string;
  outbound: string;
  return: string;
}

const blank: Form = {
  mode: 'bus',
  nameBn: '',
  operatorName: '',
  originName: '',
  destinationName: '',
  originPoint: '',
  destinationPoint: '',
  duration: '',
  fareMin: '',
  fareMax: '',
  phones: '',
  notes: '',
  stops: '',
  outbound: '',
  return: '',
};

function formOf(r: RouteDetail): Form {
  const point = (p: { lat: number; lng: number } | null) => (p ? `${p.lat}, ${p.lng}` : '');
  return {
    mode: r.mode as Form['mode'],
    nameBn: r.card.title.bn ?? '',
    operatorName: r.operatorName ?? '',
    originName: r.originName,
    destinationName: r.destinationName,
    originPoint: point(r.originLocation),
    destinationPoint: point(r.destinationLocation),
    duration: r.typicalDurationMinutes ? String(r.typicalDurationMinutes) : '',
    fareMin: r.fareMin ?? '',
    fareMax: r.fareMax ?? '',
    phones: r.contactPhones.join(', '),
    notes: r.notes ?? '',
    stops: formatStops(r.stops),
    outbound: formatDepartures(r.schedules, 'outbound'),
    return: formatDepartures(r.schedules, 'return'),
  };
}

function inputOf(f: Form): RouteInput {
  const text = (v: string) => (v.trim() ? v.trim() : null);
  const duration = Number(asciiDigits(f.duration));
  return {
    mode: f.mode,
    nameBn: f.nameBn.trim(),
    nameEn: null,
    operatorName: text(f.operatorName),
    originName: f.originName.trim(),
    destinationName: f.destinationName.trim(),
    originLocation: parsePoint(f.originPoint),
    destinationLocation: parsePoint(f.destinationPoint),
    typicalDurationMinutes:
      f.duration.trim() && Number.isInteger(duration) && duration > 0 ? duration : null,
    fareMin: text(asciiDigits(f.fareMin)),
    fareMax: text(asciiDigits(f.fareMax)),
    contactPhones: asciiDigits(f.phones)
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter(Boolean),
    notes: text(f.notes),
    stops: parseStops(f.stops),
    schedules: [...parseDepartures(f.outbound, 'outbound'), ...parseDepartures(f.return, 'return')],
  };
}

export function TransportClient({ routes }: { routes: RouteDetail[] }) {
  const t = useTranslations('localInfo.transport');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ ok: true } | { ok: false; messageKey: string }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) {
      setEditing(null);
      router.refresh();
    } else setError(tError(result.messageKey));
  }

  const set = (patch: Partial<Form>) =>
    setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));
  const field = (
    key: keyof Form,
    label: string,
    props: {
      required?: boolean;
      inputMode?: 'numeric' | 'decimal' | 'tel';
      placeholder?: string;
    } = {},
  ) =>
    editing ? (
      <div className="grid gap-1">
        <Label htmlFor={`tr-${key}`}>{label}</Label>
        <Input
          id={`tr-${key}`}
          value={editing.form[key]}
          onChange={(e) => set({ [key]: e.target.value })}
          {...props}
        />
      </div>
    ) : null;
  const area = (key: 'stops' | 'outbound' | 'return', label: string, help: string) =>
    editing ? (
      <div className="grid gap-1 md:col-span-2">
        <Label htmlFor={`tr-${key}`}>{label}</Label>
        <textarea
          id={`tr-${key}`}
          rows={4}
          className="rounded-md border bg-background p-2 font-mono text-sm"
          value={editing.form[key]}
          onChange={(e) => set({ [key]: e.target.value })}
        />
        <span className="text-xs text-muted-foreground">{help}</span>
      </div>
    ) : null;

  return (
    <>
      {editing ? (
        <form
          className="mb-6 grid gap-3 rounded-md border p-4 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => saveRoute(editing.id, inputOf(editing.form)));
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="tr-mode">{t('mode')}</Label>
            <select
              id="tr-mode"
              className="h-10 rounded-md border bg-background px-2"
              value={editing.form.mode}
              onChange={(e) => set({ mode: e.target.value as Form['mode'] })}
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`modes.${m}`)}
                </option>
              ))}
            </select>
          </div>
          {field('nameBn', t('name'), { required: true })}
          {field('originName', t('origin'), { required: true })}
          {field('destinationName', t('destination'), { required: true })}
          {field('operatorName', t('operator'))}
          {field('duration', t('duration'), { inputMode: 'numeric' })}
          {field('fareMin', t('fareMin'), { inputMode: 'decimal' })}
          {field('fareMax', t('fareMax'), { inputMode: 'decimal' })}
          {field('phones', t('phones'), { inputMode: 'tel' })}
          {field('originPoint', t('originPoint'), { placeholder: '23.81, 90.41' })}
          {field('destinationPoint', t('destinationPoint'), { placeholder: '23.72, 90.41' })}
          {area('outbound', t('outbound'), t('departuresHelp'))}
          {area('return', t('returnTimes'), t('departuresHelp'))}
          {area('stops', t('stops'), t('stopsHelp'))}
          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="tr-notes">{t('notes')}</Label>
            <Input
              id="tr-notes"
              value={editing.form.notes}
              onChange={(e) => set({ notes: e.target.value })}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive md:col-span-2">
              {error}
            </p>
          )}
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" disabled={busy}>
              {t('save')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              {t('cancelEdit')}
            </Button>
          </div>
        </form>
      ) : (
        <Button className="mb-4" onClick={() => setEditing({ id: null, form: blank })}>
          {t('add')}
        </Button>
      )}

      {routes.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {routes.map((r) => (
            <li key={r.card.id} className="rounded-md border p-3">
              <p className="font-medium">
                {r.card.title.bn}{' '}
                <span className="text-sm text-muted-foreground">· {t(`modes.${r.mode}`)}</span>
              </p>
              <p className="text-sm">
                {r.originName} → {r.destinationName} ·{' '}
                {t('departures', { count: r.schedules.length })}
              </p>
              <p
                className={
                  r.card.isStale ? 'text-xs text-amber-700' : 'text-xs text-muted-foreground'
                }
              >
                {r.lastVerifiedAt
                  ? t('verifiedOn', {
                      date: format.dateTime(new Date(r.lastVerifiedAt), { dateStyle: 'medium' }),
                    })
                  : t('neverVerified')}
                {r.card.isStale ? ` · ${t('stale')}` : ''}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing({ id: r.card.id, form: formOf(r) })}
                >
                  {t('edit')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => verifyRoute(r.card.id))}
                >
                  {t('verify')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirm({ title: t('deleteConfirm', { name: r.card.title.bn ?? '' }) })
                    ) {
                      void run(() => deleteRoute(r.card.id));
                    }
                  }}
                >
                  {t('delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

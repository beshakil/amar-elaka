'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { GovServiceDetail, InfoCard } from '@/lib/api/schemas';
import { govServiceAction, saveGovService, type GovInput } from '../actions';
import { asciiDigits, lines, pairs, parsePoint } from '../engine-form';

const CATEGORIES = [
  'identity',
  'certificate',
  'land',
  'license',
  'social_safety',
  'agriculture',
  'education',
  'health',
  'utility',
  'other',
] as const;

interface Form {
  slug: string;
  category: GovInput['category'];
  nameBn: string;
  summaryBn: string;
  officeName: string;
  address: string;
  point: string;
  hours: string;
  documents: string;
  fees: string;
  steps: string;
  links: string;
  changeNote: string;
}

const blank: Form = {
  slug: '',
  category: 'certificate',
  nameBn: '',
  summaryBn: '',
  officeName: '',
  address: '',
  point: '',
  hours: '',
  documents: '',
  fees: '',
  steps: '',
  links: '',
  changeNote: '',
};

function formOf(s: GovServiceDetail): Form {
  const v = s.current;
  return {
    slug: s.slug,
    category: s.category as Form['category'],
    nameBn: v.name.bn ?? '',
    summaryBn: v.summary ?? '',
    officeName: v.officeName,
    address: v.address ?? '',
    point: v.location ? `${v.location.lat}, ${v.location.lng}` : '',
    hours: v.hours ?? '',
    documents: v.documents.join('\n'),
    fees: v.fees.map((f) => `${f.label} | ${f.amount}`).join('\n'),
    steps: v.steps.join('\n'),
    links: v.links.map((l) => `${l.label} | ${l.url}`).join('\n'),
    changeNote: '',
  };
}

function inputOf(f: Form): GovInput {
  const text = (v: string) => (v.trim() ? v.trim() : null);
  return {
    slug: f.slug.trim(),
    category: f.category,
    nameBn: f.nameBn.trim(),
    nameEn: null,
    summaryBn: text(f.summaryBn),
    officeName: f.officeName.trim(),
    address: text(f.address),
    location: parsePoint(f.point),
    hours: text(f.hours),
    documents: lines(f.documents),
    fees: pairs(asciiDigits(f.fees)).map((p) => ({ label: p.label, amount: p.value })),
    steps: lines(f.steps),
    links: pairs(f.links).map((p) => ({ label: p.label, url: p.value })),
    changeNote: text(f.changeNote),
  };
}

export function GovClient({
  services,
  editing,
}: {
  services: InfoCard[];
  editing: GovServiceDetail | null;
}) {
  const t = useTranslations('localInfo.gov');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const [form, setForm] = useState<Form | null>(editing ? formOf(editing) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  async function run(action: () => Promise<{ ok: true } | { ok: false; messageKey: string }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) {
      setForm(null);
      router.push('/local-info/gov');
      router.refresh();
    } else setError(tError(result.messageKey));
  }

  const input = (key: keyof Form, label: string, required = false, wide = false) =>
    form ? (
      <div className={`grid gap-1 ${wide ? 'md:col-span-2' : ''}`}>
        <Label htmlFor={`g-${key}`}>{label}</Label>
        <Input
          id={`g-${key}`}
          value={form[key]}
          onChange={(e) => set({ [key]: e.target.value })}
          required={required}
        />
      </div>
    ) : null;
  const area = (key: 'documents' | 'fees' | 'steps' | 'links', label: string, help: string) =>
    form ? (
      <div className="grid gap-1 md:col-span-2">
        <Label htmlFor={`g-${key}`}>{label}</Label>
        <textarea
          id={`g-${key}`}
          rows={4}
          className="rounded-md border bg-background p-2 text-sm"
          value={form[key]}
          onChange={(e) => set({ [key]: e.target.value })}
        />
        <span className="text-xs text-muted-foreground">{help}</span>
      </div>
    ) : null;

  return (
    <>
      {form ? (
        <form
          className="mb-6 grid gap-3 rounded-md border p-4 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => saveGovService(editing?.id ?? null, inputOf(form)));
          }}
        >
          {input('nameBn', t('name'), true)}
          <div className="grid gap-1">
            <Label htmlFor="g-category">{t('category')}</Label>
            <select
              id="g-category"
              className="h-10 rounded-md border bg-background px-2"
              value={form.category}
              onChange={(e) => set({ category: e.target.value as Form['category'] })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`categories.${c}`)}
                </option>
              ))}
            </select>
          </div>
          {editing ? null : (
            <div className="grid gap-1">
              <Label htmlFor="g-slug">{t('slug')}</Label>
              <Input
                id="g-slug"
                value={form.slug}
                onChange={(e) => set({ slug: e.target.value.toLowerCase() })}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="birth-registration"
                required
              />
              <span className="text-xs text-muted-foreground">{t('slugHelp')}</span>
            </div>
          )}
          {input('summaryBn', t('summary'), false, true)}
          {input('officeName', t('office'), true)}
          {input('hours', t('hours'))}
          {input('address', t('address'), false, true)}
          <div className="grid gap-1">
            <Label htmlFor="g-point">{t('point')}</Label>
            <Input
              id="g-point"
              value={form.point}
              onChange={(e) => set({ point: e.target.value })}
              placeholder="23.81, 90.41"
            />
          </div>
          {area('documents', t('documents'), t('linesHelp'))}
          {area('fees', t('fees'), t('feesHelp'))}
          {area('steps', t('steps'), t('linesHelp'))}
          {area('links', t('links'), t('linksHelp'))}
          {editing ? input('changeNote', t('changeNote'), false, true) : null}
          {error && (
            <p role="alert" className="text-sm text-destructive md:col-span-2">
              {error}
            </p>
          )}
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" disabled={busy}>
              {editing ? t('saveVersion') : t('publish')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setForm(null);
                if (editing) router.push('/local-info/gov');
              }}
            >
              {t('cancelEdit')}
            </Button>
          </div>
        </form>
      ) : (
        <Button className="mb-4" onClick={() => setForm(blank)}>
          {t('add')}
        </Button>
      )}

      {services.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {services.map((s) => {
            const hidden = s.badges.includes('inactive');
            return (
              <li key={s.id} className={`rounded-md border p-3 ${hidden ? 'opacity-60' : ''}`}>
                <p className="font-medium">{s.title.bn ?? s.title.en}</p>
                {s.summary ? <p className="text-sm text-muted-foreground">{s.summary}</p> : null}
                <p
                  className={s.isStale ? 'text-xs text-amber-700' : 'text-xs text-muted-foreground'}
                >
                  {s.updatedAt
                    ? t('verifiedOn', {
                        date: format.dateTime(new Date(s.updatedAt), { dateStyle: 'medium' }),
                      })
                    : null}
                  {s.isStale ? ` · ${t('stale')}` : ''}
                  {hidden ? ` · ${t('hidden')}` : ''}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/local-info/gov?edit=${s.id}` as Route}>{t('edit')}</Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => govServiceAction(s.id, 'verify'))}
                  >
                    {t('verify')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => govServiceAction(s.id, hidden ? 'show' : 'hide'))}
                  >
                    {hidden ? t('show') : t('hide')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

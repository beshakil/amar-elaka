'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { BazarCatalogue, BazarEntrySheet, BazarSponsorAdmin } from '@/lib/api/schemas';
import { saveCatalogue, saveEntry, saveSponsor } from '../actions';

const UNITS = ['kg', 'litre', 'piece', 'dozen', 'hali', 'hundred'] as const;
const trimZeros = (money: string) => money.replace(/\.00$/, '');
/** Bengali digits typed into a price field become Latin before saving. */
const latin = (value: string) =>
  value.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).trim();

function useAction() {
  const tError = useTranslations('apiError');
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(
    action: () => Promise<{ ok: true } | { ok: false; messageKey: string }>,
    done: string,
  ) {
    setBusy(true);
    setMessage(null);
    const result = await action();
    setBusy(false);
    if (result.ok) {
      setMessage({ ok: true, text: done });
      router.refresh();
    } else setMessage({ ok: false, text: tError(result.messageKey) });
  }
  return { busy, message, run };
}

function Message({ message }: { message: { ok: boolean; text: string } | null }) {
  if (!message) return null;
  return (
    <p className={message.ok ? 'text-sm text-green-700' : 'text-sm text-destructive'}>
      {message.text}
    </p>
  );
}

/** One row per item, yesterday prefilled; blank rows are skipped; one save publishes all. */
export function BazarEntryForm({ sheet }: { sheet: BazarEntrySheet }) {
  const t = useTranslations('localInfo.bazar');
  const { busy, message, run } = useAction();
  const [rows, setRows] = useState(() =>
    sheet.items.map((item) => {
      const start = item.entered ?? item.previous;
      return { min: start ? trimZeros(start.min) : '', max: start ? trimZeros(start.max) : '' };
    }),
  );
  const set = (i: number, patch: Partial<{ min: string; max: string }>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  function submit() {
    const items = sheet.items.flatMap((item, i) => {
      const min = latin(rows[i]!.min);
      const max = latin(rows[i]!.max) || min;
      return min
        ? [{ commodityId: item.commodityId, unitCode: item.unit, minPrice: min, maxPrice: max }]
        : [];
    });
    void run(() => saveEntry({ date: sheet.date, items }), t('saved', { count: items.length }));
  }

  return (
    <section className="mb-8 rounded-md border p-4">
      <h2 className="mb-1 font-semibold">{t('entryTitle', { date: sheet.date })}</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {t('entryHelp', { earliest: sheet.earliestDate })}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1">{t('item')}</th>
              <th className="py-1">{t('previous')}</th>
              <th className="py-1">{t('min')}</th>
              <th className="py-1">{t('max')}</th>
            </tr>
          </thead>
          <tbody>
            {sheet.items.map((item, i) => (
              <tr key={`${item.commodityId}-${item.unit}`} className="border-t">
                <td className="py-1">
                  {item.name.bn}{' '}
                  <span className="text-muted-foreground">/{t(`units.${item.unit}`)}</span>
                </td>
                <td className="py-1 text-muted-foreground">
                  {item.previous
                    ? `${trimZeros(item.previous.min)}–${trimZeros(item.previous.max)}`
                    : '—'}
                </td>
                <td className="py-1 pr-2">
                  <Input
                    inputMode="decimal"
                    aria-label={`${item.name.bn ?? item.code} ${t('min')}`}
                    value={rows[i]!.min}
                    onChange={(e) => set(i, { min: e.target.value })}
                  />
                </td>
                <td className="py-1">
                  <Input
                    inputMode="decimal"
                    aria-label={`${item.name.bn ?? item.code} ${t('max')}`}
                    value={rows[i]!.max}
                    onChange={(e) => set(i, { max: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {t('publish')}
          </Button>
          <Message message={message} />
        </div>
      </form>
    </section>
  );
}

/** Which commodities the area's board shows, in what unit and order. None = every one. */
export function BazarCatalogueForm({ catalogue }: { catalogue: BazarCatalogue }) {
  const t = useTranslations('localInfo.bazar');
  const { busy, message, run } = useAction();
  const [chosen, setChosen] = useState(
    () =>
      new Map(
        catalogue.commodities
          .filter((c) => c.selected)
          .map((c) => [c.id, c.selected!.unit] as const),
      ),
  );
  const toggle = (id: string, unit: string, on: boolean) =>
    setChosen((m) => {
      const next = new Map(m);
      if (on) next.set(id, unit);
      else next.delete(id);
      return next;
    });

  return (
    <section className="mb-8 rounded-md border p-4">
      <h2 className="mb-1 font-semibold">{t('catalogueTitle')}</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {catalogue.customised ? t('catalogueCustom') : t('catalogueAll')}
      </p>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {catalogue.commodities.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              id={`cat-${c.id}`}
              checked={chosen.has(c.id)}
              onChange={(e) => toggle(c.id, chosen.get(c.id) ?? c.defaultUnit, e.target.checked)}
            />
            <label htmlFor={`cat-${c.id}`} className="flex-1">
              {c.name.bn}
            </label>
            <select
              aria-label={t('unit')}
              className="rounded border bg-background px-1"
              value={chosen.get(c.id) ?? c.defaultUnit}
              disabled={!chosen.has(c.id)}
              onChange={(e) => toggle(c.id, e.target.value, true)}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`units.${u}`)}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-3">
        <Button
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                saveCatalogue({
                  items: catalogue.commodities
                    .filter((c) => chosen.has(c.id))
                    .map((c, i) => ({
                      commodityId: c.id,
                      unitCode: chosen.get(c.id)!,
                      sortOrder: (i + 1) * 10,
                    })),
                }),
              t('catalogueSaved'),
            )
          }
        >
          {t('saveCatalogue')}
        </Button>
        <Message message={message} />
      </div>
    </section>
  );
}

/** The sponsorship slot on the public board: display only. */
export function BazarSponsorForm({ sponsor }: { sponsor: BazarSponsorAdmin['sponsor'] }) {
  const t = useTranslations('localInfo.bazar');
  const { busy, message, run } = useAction();
  const [form, setForm] = useState({
    nameBn: sponsor?.nameBn ?? '',
    taglineBn: sponsor?.taglineBn ?? '',
    linkUrl: sponsor?.linkUrl ?? '',
    startsOn: sponsor?.startsOn ?? new Date().toISOString().slice(0, 10),
    endsOn: sponsor?.endsOn ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <section className="rounded-md border p-4">
      <h2 className="mb-1 font-semibold">{t('sponsorTitle')}</h2>
      <p className="mb-3 text-xs text-muted-foreground">{t('sponsorHelp')}</p>
      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              saveSponsor({
                nameBn: form.nameBn,
                nameEn: null,
                taglineBn: form.taglineBn || null,
                linkUrl: form.linkUrl || null,
                startsOn: form.startsOn,
                endsOn: form.endsOn || null,
              }),
            t('sponsorSaved'),
          );
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor="sp-name">{t('sponsorName')}</Label>
          <Input
            id="sp-name"
            value={form.nameBn}
            onChange={(e) => set({ nameBn: e.target.value })}
            required
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="sp-tagline">{t('sponsorTagline')}</Label>
          <Input
            id="sp-tagline"
            value={form.taglineBn}
            onChange={(e) => set({ taglineBn: e.target.value })}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="sp-link">{t('sponsorLink')}</Label>
          <Input
            id="sp-link"
            type="url"
            placeholder="https://"
            value={form.linkUrl}
            onChange={(e) => set({ linkUrl: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1">
            <Label htmlFor="sp-from">{t('sponsorFrom')}</Label>
            <Input
              id="sp-from"
              type="date"
              value={form.startsOn}
              onChange={(e) => set({ startsOn: e.target.value })}
              required
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="sp-to">{t('sponsorTo')}</Label>
            <Input
              id="sp-to"
              type="date"
              value={form.endsOn}
              onChange={(e) => set({ endsOn: e.target.value })}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 md:col-span-2">
          <Button type="submit" disabled={busy}>
            {t('sponsorSave')}
          </Button>
          {sponsor && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => saveSponsor(null), t('sponsorCleared'))}
            >
              {t('sponsorClear')}
            </Button>
          )}
          <Message message={message} />
        </div>
      </form>
    </section>
  );
}

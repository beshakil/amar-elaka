'use client';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OutageAdminList } from '@/lib/api/schemas';
import { cancelOutage, saveOutage, type OutageInput } from '../actions';
import { fromLocalInput, toLocalInput } from '../engine-form';

const UTILITIES = ['electricity', 'gas', 'water'] as const;

type Form = Omit<OutageInput, 'startsAt' | 'endsAt'> & { startsAt: string; endsAt: string };

const blank: Form = {
  utility: 'electricity',
  localityId: null,
  areaText: null,
  startsAt: '',
  endsAt: '',
  reason: null,
};

export function OutagesClient({ list }: { list: OutageAdminList }) {
  const t = useTranslations('localInfo.outages');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locality = (localityId: string | null) =>
    list.localities.find((l) => l.id === localityId)?.name.bn ?? null;

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

  function submit() {
    if (!editing) return;
    const startsAt = fromLocalInput(editing.form.startsAt);
    const endsAt = fromLocalInput(editing.form.endsAt);
    if (!startsAt || !endsAt) {
      setError(tError('validationFailed'));
      return;
    }
    void run(() => saveOutage(editing.id, { ...editing.form, startsAt, endsAt }));
  }

  return (
    <>
      {editing ? (
        <form
          className="mb-6 grid gap-3 rounded-md border p-4 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="o-utility">{t('utility')}</Label>
            <select
              id="o-utility"
              className="h-11 rounded-md border bg-background px-2"
              value={editing.form.utility}
              onChange={(e) => set({ utility: e.target.value as Form['utility'] })}
            >
              {UTILITIES.map((u) => (
                <option key={u} value={u}>
                  {t(`utilities.${u}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="o-locality">{t('locality')}</Label>
            <select
              id="o-locality"
              className="h-11 rounded-md border bg-background px-2"
              value={editing.form.localityId ?? ''}
              onChange={(e) => set({ localityId: e.target.value || null })}
            >
              <option value="">{t('wholeArea')}</option>
              {list.localities.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name.bn ?? l.name.en}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="o-area">{t('areaText')}</Label>
            <Input
              id="o-area"
              value={editing.form.areaText ?? ''}
              onChange={(e) => set({ areaText: e.target.value || null })}
              placeholder={t('areaTextHint')}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="o-start">{t('startsAt')}</Label>
            <Input
              id="o-start"
              type="datetime-local"
              value={editing.form.startsAt}
              onChange={(e) => set({ startsAt: e.target.value })}
              required
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="o-end">{t('endsAt')}</Label>
            <Input
              id="o-end"
              type="datetime-local"
              value={editing.form.endsAt}
              onChange={(e) => set({ endsAt: e.target.value })}
              required
            />
          </div>
          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="o-reason">{t('reason')}</Label>
            <Input
              id="o-reason"
              value={editing.form.reason ?? ''}
              onChange={(e) => set({ reason: e.target.value || null })}
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

      {list.items.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {list.items.map((o) => (
            <li key={o.id} className="rounded-md border p-3">
              <p className="font-medium">
                {t(`utilities.${o.utility}`)} ·{' '}
                {locality(o.localityId) ?? o.areaText ?? t('wholeArea')}
              </p>
              <p className="text-sm">
                {format.dateTime(new Date(o.startsAt), { dateStyle: 'medium', timeStyle: 'short' })}{' '}
                – {format.dateTime(new Date(o.endsAt), { timeStyle: 'short' })}
              </p>
              {o.reason ? <p className="text-sm text-muted-foreground">{o.reason}</p> : null}
              <p className="text-xs text-muted-foreground">{t(`status.${o.status}`)}</p>
              {o.status === 'scheduled' ? (
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEditing({
                        id: o.id,
                        form: {
                          utility: o.utility as Form['utility'],
                          localityId: o.localityId,
                          areaText: o.areaText,
                          startsAt: toLocalInput(o.startsAt),
                          endsAt: toLocalInput(o.endsAt),
                          reason: o.reason,
                        },
                      })
                    }
                  >
                    {t('edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    disabled={busy}
                    onClick={async () => {
                      if (await confirm({ title: t('cancelConfirm') }))
                        void run(() => cancelOutage(o.id));
                    }}
                  >
                    {t('cancelOutage')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

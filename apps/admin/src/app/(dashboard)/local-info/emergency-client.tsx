'use client';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirm } from '@/components/ui/confirm';
import { Label } from '@/components/ui/label';
import type { EmergencyAdminContact } from '@/lib/api/schemas';
import { deleteContact, saveContact, verifyContact, type ContactInput } from './actions';

/** emergency_service_types an area adds itself (the national ones are global). */
const LOCAL_TYPES = [
  'police',
  'fire_service',
  'hospital',
  'ambulance',
  'pharmacy_24h',
  'electricity',
  'gas',
  'union_parishad',
  'upazila_office',
  'women_child_helpline',
] as const;

const blank: ContactInput = {
  serviceType: 'police',
  nameBn: '',
  nameEn: null,
  phones: [],
  address: null,
  location: null,
  is24h: false,
  availabilityNote: null,
  sortOrder: 0,
  isActive: true,
};

export function EmergencyClient({ items }: { items: EmergencyAdminContact[] }) {
  const t = useTranslations('localInfo.emergency');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ id: string | null; input: ContactInput } | null>(null);
  const [phones, setPhones] = useState('');
  const [point, setPoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(id: string | null, input: ContactInput) {
    setEditing({ id, input });
    setPhones(input.phones.join(', '));
    setPoint(input.location ? `${input.location.lat}, ${input.location.lng}` : '');
    setError(null);
  }

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

  function submit() {
    if (!editing) return;
    const [lat, lng] = point.split(',').map((v) => Number(v.trim()));
    const location =
      point.trim() && Number.isFinite(lat) && Number.isFinite(lng)
        ? { lat: lat!, lng: lng! }
        : null;
    void run(() =>
      saveContact(editing.id, {
        ...editing.input,
        phones: phones
          .split(/[,\s]+/)
          .map((p) => p.trim())
          .filter(Boolean),
        location,
      }),
    );
  }

  const set = (patch: Partial<ContactInput>) =>
    setEditing((e) => (e ? { ...e, input: { ...e.input, ...patch } } : e));

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
            <Label htmlFor="ec-type">{t('type')}</Label>
            <select
              id="ec-type"
              className="h-9 rounded-md border bg-background px-2"
              value={editing.input.serviceType}
              onChange={(e) => set({ serviceType: e.target.value })}
            >
              {LOCAL_TYPES.map((code) => (
                <option key={code} value={code}>
                  {t(`types.${code}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="ec-name">{t('nameBn')}</Label>
            <Input
              id="ec-name"
              value={editing.input.nameBn}
              onChange={(e) => set({ nameBn: e.target.value })}
              required
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="ec-phones">{t('phones')}</Label>
            <Input
              id="ec-phones"
              value={phones}
              onChange={(e) => setPhones(e.target.value)}
              placeholder="+8801…, 16163"
              required
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="ec-point">{t('location')}</Label>
            <Input
              id="ec-point"
              value={point}
              onChange={(e) => setPoint(e.target.value)}
              placeholder="23.80, 90.40"
            />
          </div>
          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="ec-address">{t('address')}</Label>
            <Input
              id="ec-address"
              value={editing.input.address ?? ''}
              onChange={(e) => set({ address: e.target.value || null })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editing.input.is24h}
              onChange={(e) => set({ is24h: e.target.checked })}
            />
            {t('is24h')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editing.input.isActive}
              onChange={(e) => set({ isActive: e.target.checked })}
            />
            {t('active')}
          </label>
          {error && <p className="text-sm text-destructive md:col-span-2">{error}</p>}
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" disabled={busy}>
              {t('save')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <Button className="mb-4" onClick={() => open(null, blank)}>
          {t('add')}
        </Button>
      )}
      {items.length === 0 ? (
        <p className="rounded-md border p-6 text-center text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="emergency-contacts">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-48 flex-1">
                <p className="font-medium">
                  {item.name.bn}
                  {!item.isActive && (
                    <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs">
                      {t('inactive')}
                    </span>
                  )}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t.has(`types.${item.serviceType}`)
                    ? t(`types.${item.serviceType}`)
                    : item.serviceType}{' '}
                  · {item.phones.join(', ')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.lastVerifiedAt
                    ? t('verifiedAt', {
                        date: format.dateTime(new Date(item.lastVerifiedAt), {
                          dateStyle: 'medium',
                        }),
                      })
                    : t('neverVerified')}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => verifyContact(item.id))}
              >
                {t('verify')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  open(item.id, {
                    serviceType: item.serviceType,
                    nameBn: item.name.bn ?? '',
                    nameEn: item.name.en,
                    phones: item.phones,
                    address: item.address,
                    location: item.location,
                    is24h: item.is24h,
                    availabilityNote: item.availabilityNote,
                    sortOrder: item.sortOrder,
                    isActive: item.isActive,
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
                  if (!(await confirm({ title: t('deleteConfirm', { name: item.name.bn ?? '' }) })))
                    return;
                  await run(() => deleteContact(item.id));
                }}
              >
                {t('delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

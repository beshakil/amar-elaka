'use client';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { InfoCard } from '@/lib/api/schemas';
import { decideInfoItem, publishNotice, type NoticeInput } from '../actions';
import { fromLocalInput } from '../engine-form';

const TYPES = [
  'union_parishad',
  'pourashava',
  'government',
  'education',
  'religious',
  'community_event',
  'weather_alert',
] as const;

// Mirrors the API's minimum reason length (it checks again).
const REASON_MIN = 3;

interface Attachment {
  id: string;
  name: string;
}

const blank = {
  type: 'union_parishad' as NoticeInput['type'],
  title: '',
  body: '',
  issuerName: '',
  validFrom: '',
  expiresAt: '',
  isOfficial: false,
  isPinned: false,
};

export function NoticesClient({ notices, staff }: { notices: InfoCard[]; staff: boolean }) {
  const t = useTranslations('localInfo.notices');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const [form, setForm] = useState(blank);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; reason: string } | null>(null);

  const set = (patch: Partial<typeof blank>) => setForm((f) => ({ ...f, ...patch }));

  async function upload(files: FileList | null) {
    if (!files) return;
    setUploading(true);
    setMessage(null);
    for (const file of Array.from(files)) {
      const response = await fetch('/api/info/attachments', {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      }).catch(() => null);
      const body = (await response?.json().catch(() => null)) as {
        mediaId?: string;
        messageKey?: string;
      } | null;
      if (response?.ok && body?.mediaId) {
        setAttachments((list) => [...list, { id: body.mediaId!, name: file.name }]);
      } else {
        setMessage({ ok: false, text: tError(body?.messageKey ?? 'unreachable') });
      }
    }
    setUploading(false);
  }

  async function submit() {
    setBusy(true);
    setMessage(null);
    const result = await publishNotice({
      type: form.type,
      title: form.title.trim(),
      body: form.body.trim(),
      issuerName: form.issuerName.trim() || null,
      validFrom: fromLocalInput(form.validFrom),
      expiresAt: fromLocalInput(form.expiresAt),
      isOfficial: staff && form.isOfficial,
      isPinned: staff && form.isPinned,
      attachmentIds: attachments.map((a) => a.id),
    });
    setBusy(false);
    if (result.ok) {
      setForm(blank);
      setAttachments([]);
      setMessage({ ok: true, text: t('published') });
      router.refresh();
    } else setMessage({ ok: false, text: tError(result.messageKey) });
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    const result = await decideInfoItem('notice', removing.id, {
      decision: 'remove',
      reasonCode: 'policy_violation',
      reasonText: removing.reason.trim(),
    });
    setBusy(false);
    if (result.ok) {
      setRemoving(null);
      router.refresh();
    } else setMessage({ ok: false, text: tError(result.messageKey) });
  }

  return (
    <>
      <form
        className="mb-6 grid gap-3 rounded-md border p-4 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor="n-type">{t('type')}</Label>
          <select
            id="n-type"
            className="h-10 rounded-md border bg-background px-2"
            value={form.type}
            onChange={(e) => set({ type: e.target.value as NoticeInput['type'] })}
          >
            {TYPES.map((code) => (
              <option key={code} value={code}>
                {t(`types.${code}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="n-issuer">{t('issuer')}</Label>
          <Input
            id="n-issuer"
            value={form.issuerName}
            onChange={(e) => set({ issuerName: e.target.value })}
          />
        </div>
        <div className="grid gap-1 md:col-span-2">
          <Label htmlFor="n-title">{t('noticeTitle')}</Label>
          <Input
            id="n-title"
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            required
          />
        </div>
        <div className="grid gap-1 md:col-span-2">
          <Label htmlFor="n-body">{t('body')}</Label>
          <textarea
            id="n-body"
            rows={5}
            className="rounded-md border bg-background p-2"
            value={form.body}
            onChange={(e) => set({ body: e.target.value })}
            required
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="n-from">{t('validFrom')}</Label>
          <Input
            id="n-from"
            type="datetime-local"
            value={form.validFrom}
            onChange={(e) => set({ validFrom: e.target.value })}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="n-until">{t('expiresAt')}</Label>
          <Input
            id="n-until"
            type="datetime-local"
            value={form.expiresAt}
            onChange={(e) => set({ expiresAt: e.target.value })}
          />
          <span className="text-xs text-muted-foreground">{t('expiresHelp')}</span>
        </div>
        <div className="grid gap-1 md:col-span-2">
          <Label htmlFor="n-files">{t('attachments')}</Label>
          <input
            id="n-files"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            multiple
            disabled={uploading}
            onChange={(e) => void upload(e.target.files)}
          />
          <span className="text-xs text-muted-foreground">
            {uploading ? t('uploading') : t('attachmentsHelp')}
          </span>
          {attachments.length > 0 && (
            <ul className="text-sm">
              {attachments.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  {a.name}
                  <button
                    type="button"
                    className="text-destructive underline"
                    onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                  >
                    {t('removeAttachment')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {staff && (
          <div className="flex flex-wrap gap-4 md:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isOfficial}
                onChange={(e) => set({ isOfficial: e.target.checked })}
              />
              {t('official')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isPinned}
                onChange={(e) => set({ isPinned: e.target.checked })}
              />
              {t('pinned')}
            </label>
          </div>
        )}
        {message && (
          <p
            role="status"
            className={`text-sm md:col-span-2 ${message.ok ? 'text-green-700' : 'text-destructive'}`}
          >
            {message.text}
          </p>
        )}
        <div className="md:col-span-2">
          <Button type="submit" disabled={busy || uploading}>
            {t('publish')}
          </Button>
        </div>
      </form>

      <h2 className="mb-2 font-semibold">{t('current')}</h2>
      {notices.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {notices.map((n) => (
            <li key={n.id} className="rounded-md border p-3">
              <p className="font-medium">{n.title.bn ?? n.title.en}</p>
              {n.summary ? (
                <p className="line-clamp-2 text-sm text-muted-foreground">{n.summary}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {n.startsAt ? format.dateTime(new Date(n.startsAt), { dateStyle: 'medium' }) : null}
                {n.endsAt
                  ? ` – ${format.dateTime(new Date(n.endsAt), { dateStyle: 'medium' })}`
                  : null}
              </p>
              {staff &&
                (removing?.id === n.id ? (
                  <div className="mt-2 grid gap-2">
                    <Input
                      aria-label={t('removeReason')}
                      placeholder={t('removeReason')}
                      value={removing.reason}
                      onChange={(e) => setRemoving({ id: n.id, reason: e.target.value })}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive"
                        disabled={busy || removing.reason.trim().length < REASON_MIN}
                        onClick={() => void remove()}
                      >
                        {t('remove')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                        {t('cancelEdit')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 text-destructive"
                    onClick={() => setRemoving({ id: n.id, reason: '' })}
                  >
                    {t('remove')}
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

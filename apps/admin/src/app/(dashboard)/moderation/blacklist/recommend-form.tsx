'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { BLACKLIST_REASONS, BLACKLIST_SEVERITIES, EVIDENCE_TYPES } from '@/lib/api/schemas';
import { findMember, recommendBlacklist } from '../bans/actions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Recommend a member of this area for the global blacklist — with evidence; the platform decides. */
export function RecommendForm() {
  const t = useTranslations('blacklist');
  const tBan = useTranslations('bans');
  const tError = useTranslations('apiError');
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [subject, setSubject] = useState<{ userId: string; name: string | null } | null>(null);
  const [reasonCode, setReasonCode] =
    useState<(typeof BLACKLIST_REASONS)[number]>('advance_payment_scam');
  const [severity, setSeverity] = useState<(typeof BLACKLIST_SEVERITIES)[number]>('banned');
  const [summary, setSummary] = useState('');
  const [evidenceType, setEvidenceType] = useState<(typeof EVIDENCE_TYPES)[number]>('report');
  const [evidenceId, setEvidenceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function lookup() {
    setMessage(null);
    const result = await findMember(phone);
    if (!result.ok) return setMessage(tError(result.messageKey));
    const [first] = result.items;
    if (!first) return setMessage(tBan('noMember'));
    setSubject({ userId: first.userId, name: first.displayName });
  }

  async function submit() {
    if (!subject) return;
    setBusy(true);
    setMessage(null);
    const result = await recommendBlacklist({
      userId: subject.userId,
      reasonCode,
      severity,
      summary,
      evidence: [{ type: evidenceType, id: evidenceId }],
    });
    setBusy(false);
    if (result.ok) {
      setSubject(null);
      setSummary('');
      setEvidenceId('');
      setMessage(t('sent'));
      router.refresh();
    } else setMessage(tError(result.messageKey));
  }

  return (
    <section className="max-w-2xl space-y-3 rounded-md border p-4" data-testid="recommend-form">
      <h2 className="font-medium">{t('recommend')}</h2>
      {subject ? (
        <p className="text-sm">
          {tBan('subject')}: <span className="font-medium">{subject.name ?? t('unnamed')}</span>
        </p>
      ) : (
        <div className="flex items-end gap-2">
          <label className="flex-1 text-sm">
            {tBan('phone')}
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 block w-full rounded-md border bg-background p-2"
              inputMode="tel"
            />
          </label>
          <Button variant="outline" onClick={() => void lookup()}>
            {tBan('find')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          {t('reasonLabel')}
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value as (typeof BLACKLIST_REASONS)[number])}
            className="mt-1 block rounded-md border bg-background p-2"
          >
            {BLACKLIST_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`reason.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t('severityLabel')}
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as (typeof BLACKLIST_SEVERITIES)[number])}
            className="mt-1 block rounded-md border bg-background p-2"
          >
            {BLACKLIST_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {t(`severity.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm">
        {t('summary')}
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-md border bg-background p-2"
        />
      </label>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label>
          {tBan('evidence')}
          <select
            value={evidenceType}
            onChange={(e) => setEvidenceType(e.target.value as (typeof EVIDENCE_TYPES)[number])}
            className="mt-1 block rounded-md border bg-background p-2"
          >
            {EVIDENCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {tBan(`evidenceType.${type}`)}
              </option>
            ))}
          </select>
        </label>
        <input
          value={evidenceId}
          onChange={(e) => setEvidenceId(e.target.value.trim())}
          placeholder={tBan('evidenceIdPlaceholder')}
          className="min-w-72 flex-1 rounded-md border bg-background p-2"
        />
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <Button
        disabled={busy || !subject || !summary.trim() || !UUID.test(evidenceId)}
        onClick={() => void submit()}
        data-testid="recommend-submit"
      >
        {t('recommend')}
      </Button>
    </section>
  );
}

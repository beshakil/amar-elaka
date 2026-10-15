'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { BAN_REASONS, EVIDENCE_TYPES } from '@/lib/api/schemas';
import { findMember, issueBan } from '../actions';

type Subject = { userId: string; name: string | null };
type Evidence = { type: (typeof EVIDENCE_TYPES)[number]; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function BanForm({
  initial,
  complaintId,
  canPermanent,
}: {
  initial: Subject | null;
  complaintId: string | null;
  canPermanent: boolean;
}) {
  const t = useTranslations('bans');
  const tError = useTranslations('apiError');
  const router = useRouter();
  const [subject, setSubject] = useState<Subject | null>(initial);
  const [phone, setPhone] = useState('');
  const [matches, setMatches] = useState<Subject[] | null>(null);
  const [severity, setSeverity] = useState<'restricted' | 'banned'>('restricted');
  const [reasonCode, setReasonCode] = useState<(typeof BAN_REASONS)[number]>('scam');
  const [reasonText, setReasonText] = useState('');
  const [evidence, setEvidence] = useState<Evidence[]>(
    complaintId ? [{ type: 'complaint', id: complaintId }] : [],
  );
  const [evidenceType, setEvidenceType] = useState<Evidence['type']>('report');
  const [evidenceId, setEvidenceId] = useState('');
  const [length, setLength] = useState<'ladder' | 'days' | 'permanent'>('ladder');
  const [days, setDays] = useState('');
  const [override, setOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup() {
    setError(null);
    const result = await findMember(phone);
    if (!result.ok) return setError(tError(result.messageKey));
    setMatches(result.items.map((m) => ({ userId: m.userId, name: m.displayName })));
  }

  async function submit() {
    if (!subject) return;
    setBusy(true);
    setError(null);
    const result = await issueBan({
      userId: subject.userId,
      severity,
      reasonCode,
      reasonText,
      evidence,
      ...(length === 'days' && days ? { durationDays: Number(days) } : {}),
      ...(length === 'permanent' ? { permanent: true } : {}),
      ...(length !== 'ladder' && override.trim() ? { overrideReason: override } : {}),
      ...(complaintId ? { complaintId } : {}),
    });
    setBusy(false);
    if (result.ok) router.push('/moderation/bans');
    else setError(tError(result.messageKey));
  }

  return (
    <section className="max-w-2xl space-y-4 rounded-md border p-4" data-testid="ban-form">
      {subject ? (
        <p className="text-sm">
          {t('subject')}: <span className="font-medium">{subject.name ?? t('unnamed')}</span>
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-end gap-2">
            <label className="flex-1 text-sm">
              {t('phone')}
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="mt-1 block w-full rounded-md border bg-background p-2"
                inputMode="tel"
              />
            </label>
            <Button variant="outline" onClick={() => void lookup()} data-testid="ban-lookup">
              {t('find')}
            </Button>
          </div>
          {matches?.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('noMember')}</p>
          )}
          {matches?.map((m) => (
            <button
              key={m.userId}
              type="button"
              onClick={() => setSubject(m)}
              className="block w-full rounded-md border p-2 text-left text-sm hover:bg-muted"
            >
              {m.name ?? t('unnamed')}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          {t('severityLabel')}
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as 'restricted' | 'banned')}
            className="mt-1 block rounded-md border bg-background p-2"
          >
            <option value="restricted">{t('severity.restricted')}</option>
            <option value="banned">{t('severity.banned')}</option>
          </select>
        </label>
        <label className="text-sm">
          {t('reasonLabel')}
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value as (typeof BAN_REASONS)[number])}
            className="mt-1 block rounded-md border bg-background p-2"
          >
            {BAN_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`reason.${r}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t(`severityHelp.${severity}`)}</p>
      <label className="block text-sm">
        {t('reasonText')}
        <textarea
          value={reasonText}
          onChange={(e) => setReasonText(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-md border bg-background p-2"
          placeholder={t('reasonTextPlaceholder')}
        />
      </label>
      <fieldset className="space-y-2 text-sm">
        <legend>{t('evidence')}</legend>
        {evidence.map((e, i) => (
          <div key={`${e.type}-${e.id}`} className="flex items-center gap-2">
            <span className="rounded bg-muted px-2 py-0.5 text-xs">
              {t(`evidenceType.${e.type}`)}
            </span>
            <code className="text-xs">{e.id}</code>
            <button
              type="button"
              className="text-xs underline"
              onClick={() => setEvidence(evidence.filter((_, j) => j !== i))}
            >
              {t('remove')}
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <select
            value={evidenceType}
            onChange={(e) => setEvidenceType(e.target.value as Evidence['type'])}
            className="rounded-md border bg-background p-2"
          >
            {EVIDENCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`evidenceType.${type}`)}
              </option>
            ))}
          </select>
          <input
            value={evidenceId}
            onChange={(e) => setEvidenceId(e.target.value.trim())}
            placeholder={t('evidenceIdPlaceholder')}
            className="min-w-72 flex-1 rounded-md border bg-background p-2"
          />
          <Button
            variant="outline"
            disabled={!UUID.test(evidenceId)}
            onClick={() => {
              setEvidence([...evidence, { type: evidenceType, id: evidenceId }]);
              setEvidenceId('');
            }}
          >
            {t('addEvidence')}
          </Button>
        </div>
      </fieldset>
      <fieldset className="space-y-2 text-sm">
        <legend>{t('length')}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={length === 'ladder'} onChange={() => setLength('ladder')} />
          {t('lengthLadder')}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={length === 'days'} onChange={() => setLength('days')} />
          {t('lengthDays')}
          <input
            type="number"
            min={1}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            disabled={length !== 'days'}
            className="w-24 rounded-md border bg-background p-1"
          />
        </label>
        {canPermanent && (
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={length === 'permanent'}
              onChange={() => setLength('permanent')}
            />
            {t('lengthPermanent')}
          </label>
        )}
        {length !== 'ladder' && (
          <label className="block">
            {t('overrideReason')}
            <input
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              className="mt-1 block w-full rounded-md border bg-background p-2"
            />
          </label>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        disabled={busy || !subject || !reasonText.trim()}
        onClick={() => void submit()}
        data-testid="ban-submit"
      >
        {t('issue')}
      </Button>
    </section>
  );
}

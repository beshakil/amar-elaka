'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AgentList, AgentRow } from '@/lib/api/schemas';
import { addAgent, changeAgent, type UpdateAgentInput } from './actions';

const toInt = (v: string) => (v.trim() === '' ? undefined : Math.max(0, Math.trunc(Number(v))));

export function AgentsClient({ list }: { list: AgentList }) {
  const t = useTranslations('agents');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  async function run(action: () => Promise<{ ok: true } | { ok: false; messageKey: string }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) {
      setAdding(false);
      router.refresh();
    } else setError(tError(result.messageKey));
  }

  return (
    <>
      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {list.candidates.length > 0 &&
        (adding ? (
          <AddAgentForm
            candidates={list.candidates}
            busy={busy}
            onCancel={() => setAdding(false)}
            run={run}
          />
        ) : (
          <Button className="mb-4" onClick={() => setAdding(true)}>
            {t('add')}
          </Button>
        ))}
      {list.items.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="agents">
          {list.items.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              busy={busy}
              run={run}
              percent={(v) => format.number(v, { style: 'percent' })}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function AgentCard({
  agent,
  busy,
  run,
  percent,
}: {
  agent: AgentRow;
  busy: boolean;
  run: (action: () => Promise<{ ok: true } | { ok: false; messageKey: string }>) => Promise<void>;
  percent: (v: number) => string;
}) {
  const t = useTranslations('agents');
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState(agent.commissionRate ?? '');
  const [daily, setDaily] = useState(agent.targets.dailyShops?.toString() ?? '');
  const [weekly, setWeekly] = useState(agent.targets.weeklyShops?.toString() ?? '');
  const [status, setStatus] = useState(agent.status as UpdateAgentInput['status']);

  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {agent.name ?? agent.code}{' '}
            <span className="text-sm text-muted-foreground">· {agent.code}</span>
          </p>
          <p className="text-xs text-muted-foreground">{t(`status.${agent.status}`)}</p>
        </div>
        {agent.flagged > 0 && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            {t('flagged', { count: agent.flagged })}
          </span>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-muted-foreground">{t('today')}</dt>
          <dd>
            {t('counts', {
              submitted: agent.today.submitted,
              approved: agent.today.approved,
              rejected: agent.today.rejected,
            })}
            {agent.targets.dailyShops !== null
              ? ` · ${t('target', { target: agent.targets.dailyShops })}`
              : ''}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('week')}</dt>
          <dd>
            {t('counts', {
              submitted: agent.week.submitted,
              approved: agent.week.approved,
              rejected: agent.week.rejected,
            })}
            {agent.targets.weeklyShops !== null
              ? ` · ${t('target', { target: agent.targets.weeklyShops })}`
              : ''}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('approvalRate')}</dt>
          <dd>{agent.approvalRate === null ? '—' : percent(agent.approvalRate)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('estimate')}</dt>
          <dd>৳ {agent.week.commission}</dd>
        </div>
      </dl>
      {editing ? (
        <form
          className="mt-3 grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              changeAgent(agent.id, {
                status,
                commissionRate: rate.trim() === '' ? null : rate.trim(),
                targets: {
                  ...(toInt(daily) !== undefined ? { daily_shops: toInt(daily) } : {}),
                  ...(toInt(weekly) !== undefined ? { weekly_shops: toInt(weekly) } : {}),
                },
              }),
            ).then(() => setEditing(false));
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={`rate-${agent.id}`}>{t('rate')}</Label>
            <Input
              id={`rate-${agent.id}`}
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder={t('rateDefault')}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`status-${agent.id}`}>{t('statusLabel')}</Label>
            <select
              id={`status-${agent.id}`}
              className="h-10 rounded-md border bg-background px-2"
              value={status}
              onChange={(e) => setStatus(e.target.value as UpdateAgentInput['status'])}
            >
              {(['active', 'suspended', 'terminated'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`daily-${agent.id}`}>{t('dailyTarget')}</Label>
            <Input
              id={`daily-${agent.id}`}
              inputMode="numeric"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`weekly-${agent.id}`}>{t('weeklyTarget')}</Label>
            <Input
              id={`weekly-${agent.id}`}
              inputMode="numeric"
              value={weekly}
              onChange={(e) => setWeekly(e.target.value)}
            />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {t('save')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {t('edit')}
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href={`/agents/${agent.id}` as Route}>{t('tasks')}</Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href={`/agents/submissions?agentId=${agent.id}` as Route}>{t('todaysWork')}</Link>
          </Button>
        </div>
      )}
    </li>
  );
}

function AddAgentForm({
  candidates,
  busy,
  onCancel,
  run,
}: {
  candidates: AgentList['candidates'];
  busy: boolean;
  onCancel: () => void;
  run: (action: () => Promise<{ ok: true } | { ok: false; messageKey: string }>) => Promise<void>;
}) {
  const t = useTranslations('agents');
  const [memberId, setMemberId] = useState(candidates[0]?.memberId ?? '');
  const [code, setCode] = useState('');
  const [type, setType] = useState<'commission_only' | 'salaried' | 'volunteer'>('commission_only');
  const [daily, setDaily] = useState('');
  return (
    <form
      className="mb-6 grid gap-3 rounded-md border p-4 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() =>
          addAgent({
            memberId,
            agentCode: code.trim(),
            employmentType: type,
            commissionRate: null,
            targets: toInt(daily) !== undefined ? { daily_shops: toInt(daily) } : {},
          }),
        );
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="a-member">{t('member')}</Label>
        <select
          id="a-member"
          className="h-10 rounded-md border bg-background px-2"
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
        >
          {candidates.map((c) => (
            <option key={c.memberId} value={c.memberId}>
              {c.name ?? c.memberId.slice(0, 8)}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{t('memberHelp')}</span>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="a-code">{t('code')}</Label>
        <Input
          id="a-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="MIR-02"
          required
          pattern="[A-Za-z0-9-]{2,20}"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="a-type">{t('employment')}</Label>
        <select
          id="a-type"
          className="h-10 rounded-md border bg-background px-2"
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
        >
          {(['commission_only', 'salaried', 'volunteer'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`employmentTypes.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="a-daily">{t('dailyTarget')}</Label>
        <Input
          id="a-daily"
          inputMode="numeric"
          value={daily}
          onChange={(e) => setDaily(e.target.value)}
        />
      </div>
      <div className="flex gap-2 md:col-span-2">
        <Button type="submit" disabled={busy || !memberId}>
          {t('add')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

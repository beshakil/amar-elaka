'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  COMPLAINT_PRIORITIES,
  type ComplaintAssignee,
  type ComplaintItem,
} from '@/lib/api/schemas';
import { cn } from '@/lib/utils';
import { resolveComplaint, updateComplaint } from '../bans/actions';

export function ComplaintsClient({
  items,
  assignees,
  filter,
  canWrite,
  canBan,
}: {
  items: ComplaintItem[];
  assignees: ComplaintAssignee[];
  filter: 'open' | 'mine' | 'resolved';
  canWrite: boolean;
  canBan: boolean;
}) {
  const t = useTranslations('complaints');
  return (
    <>
      <nav className="mb-4 flex gap-2 text-sm" aria-label={t('filter')}>
        {(['open', 'mine', 'resolved'] as const).map((key) => (
          <Link
            key={key}
            href={
              (key === 'open'
                ? '/moderation/complaints'
                : key === 'mine'
                  ? '/moderation/complaints?mine=true'
                  : '/moderation/complaints?status=resolved') as Route
            }
            aria-current={filter === key ? 'page' : undefined}
            className={cn(
              'rounded-md border px-3 py-1',
              filter === key ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
            )}
          >
            {t(`filters.${key}`)}
          </Link>
        ))}
      </nav>
      {items.length === 0 ? (
        <p
          className="rounded-md border p-6 text-center text-muted-foreground"
          data-testid="complaints-empty"
        >
          {t('empty')}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="complaints-queue">
          {items.map((item) => (
            <ComplaintCard
              key={item.id}
              item={item}
              assignees={assignees}
              canWrite={canWrite}
              canBan={canBan}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function ComplaintCard({
  item,
  assignees,
  canWrite,
  canBan,
}: {
  item: ComplaintItem;
  assignees: ComplaintAssignee[];
  canWrite: boolean;
  canBan: boolean;
}) {
  const t = useTranslations('complaints');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = item.status !== 'resolved';

  async function run(action: () => Promise<{ ok: true } | { ok: false; messageKey: string }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(tError(result.messageKey));
  }

  const banHref = `/moderation/bans/new?${new URLSearchParams({
    userId: item.subjectUserId,
    complaintId: item.id,
    name: item.subjectName ?? '',
  }).toString()}` as Route;

  return (
    <li className="rounded-md border p-4" data-testid={`complaint-${item.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.subjectName ?? t('unnamed')}</span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">
          {t(`subject.${item.subjectType}`)}
        </span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">
          {t(`category.${item.category}`)}
        </span>
        <span
          className={cn(
            'rounded px-2 py-0.5 text-xs',
            item.priority === 'urgent' || item.priority === 'high'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-muted',
          )}
        >
          {t(`priority.${item.priority}`)}
        </span>
        {item.subjectBanSeverity && (
          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-xs">
            {t('alreadyBanned', { severity: t(`severity.${item.subjectBanSeverity}`) })}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{item.reference}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{item.description}</p>
      <p
        className={cn(
          'mt-2 text-xs',
          item.overdue ? 'font-medium text-destructive' : 'text-muted-foreground',
        )}
      >
        {open
          ? t(item.overdue ? 'overdue' : 'due', {
              when: format.dateTime(new Date(item.dueAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })
          : t('resolvedOn', {
              when: format.dateTime(new Date(item.resolvedAt ?? item.createdAt), {
                dateStyle: 'medium',
              }),
            })}
        {' · '}
        {t('reportedBy', { name: item.reporterName ?? t('unnamed') })}
      </p>
      {!open && item.resolution && (
        <p className="mt-2 rounded bg-muted p-2 text-sm">{item.resolution}</p>
      )}
      {open && canWrite && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            {t('assignee')}
            <select
              value={item.assignedToUserId ?? ''}
              disabled={busy}
              onChange={(e) =>
                void run(() => updateComplaint(item.id, { assigneeUserId: e.target.value || null }))
              }
              className="mt-1 block rounded-md border bg-background p-2"
              data-testid="complaint-assignee"
            >
              <option value="">{t('unassigned')}</option>
              {assignees.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {t('assigneeOption', { name: a.displayName ?? t('unnamed'), open: a.openCount })}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            {t('priorityLabel')}
            <select
              value={item.priority}
              disabled={busy}
              onChange={(e) =>
                void run(() => updateComplaint(item.id, { priority: e.target.value }))
              }
              className="mt-1 block rounded-md border bg-background p-2"
            >
              {COMPLAINT_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`)}
                </option>
              ))}
            </select>
          </label>
          {item.status === 'pending' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => updateComplaint(item.id, { status: 'in_progress' }))}
            >
              {t('start')}
            </Button>
          )}
          {canBan && (
            <Link
              href={banHref}
              className="rounded-md border px-3 py-2 text-sm text-destructive hover:bg-muted"
              data-testid="complaint-ban"
            >
              {t('banPerson')}
            </Link>
          )}
        </div>
      )}
      {open && canWrite && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-64 flex-1 text-sm">
            {t('resolution')}
            <input
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              className="mt-1 block w-full rounded-md border bg-background p-2"
              placeholder={t('resolutionPlaceholder')}
            />
          </label>
          <Button
            disabled={busy || !resolution.trim()}
            onClick={() => void run(() => resolveComplaint(item.id, resolution))}
            data-testid="complaint-resolve"
          >
            {t('resolve')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

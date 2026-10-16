'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AgentTask } from '@/lib/api/schemas';
import { addTask, setTaskStatus, type CreateTaskInput } from '../actions';

const TYPES = ['map_shop', 'verify_shop', 'update_info'] as const;

export function TasksClient({
  agentId,
  tasks,
  today,
}: {
  agentId: string;
  tasks: AgentTask[];
  today: string;
}) {
  const t = useTranslations('agents');
  const tError = useTranslations('apiError');
  const router = useRouter();
  const [type, setType] = useState<CreateTaskInput['type']>('map_shop');
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState(today);
  const [point, setPoint] = useState('');
  const [placeId, setPlaceId] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ ok: true } | { ok: false; messageKey: string }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) {
      setTitle('');
      setNotes('');
      router.refresh();
    } else setError(tError(result.messageKey));
  }

  function submit() {
    const [lat, lng] = point.split(',').map((v) => Number(v.trim()));
    const location =
      point.trim() && Number.isFinite(lat) && Number.isFinite(lng)
        ? { lat: lat!, lng: lng! }
        : undefined;
    void run(() =>
      addTask(agentId, {
        type,
        title: title.trim(),
        dueOn,
        ...(location ? { location } : {}),
        ...(placeId.trim() ? { placeId: placeId.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    );
  }

  return (
    <>
      <form
        className="mb-6 grid gap-3 rounded-md border p-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor="t-type">{t('taskType')}</Label>
          <select
            id="t-type"
            className="h-10 rounded-md border bg-background px-2"
            value={type}
            onChange={(e) => setType(e.target.value as CreateTaskInput['type'])}
          >
            {TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`taskTypes.${x}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="t-due">{t('dueOn')}</Label>
          <Input
            id="t-due"
            type="date"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            required
          />
        </div>
        <div className="grid gap-1 md:col-span-2">
          <Label htmlFor="t-title">{t('taskTitle')}</Label>
          <Input id="t-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        {type === 'map_shop' ? (
          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="t-point">{t('taskPoint')}</Label>
            <Input
              id="t-point"
              value={point}
              onChange={(e) => setPoint(e.target.value)}
              placeholder="23.81, 90.41"
            />
          </div>
        ) : (
          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="t-place">{t('taskPlace')}</Label>
            <Input
              id="t-place"
              value={placeId}
              onChange={(e) => setPlaceId(e.target.value)}
              required
            />
            <span className="text-xs text-muted-foreground">{t('taskPlaceHelp')}</span>
          </div>
        )}
        <div className="grid gap-1 md:col-span-2">
          <Label htmlFor="t-notes">{t('notes')}</Label>
          <Input id="t-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive md:col-span-2">
            {error}
          </p>
        )}
        <div className="md:col-span-2">
          <Button type="submit" disabled={busy}>
            {t('assign')}
          </Button>
        </div>
      </form>

      {tasks.length === 0 ? (
        <p className="text-muted-foreground">{t('noTasks')}</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {tasks.map((task) => (
            <li key={task.id} className="rounded-md border p-3">
              <p className="font-medium">{task.title}</p>
              <p className="text-sm text-muted-foreground">
                {t(`taskTypes.${task.type}`)} · {task.dueOn}
                {task.placeName ? ` · ${task.placeName}` : ''}
                {task.localityName ? ` · ${task.localityName}` : ''}
              </p>
              <p className="text-xs">{t(`taskStatus.${task.status}`)}</p>
              {task.status === 'open' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => void run(() => setTaskStatus(task.id, 'cancelled'))}
                >
                  {t('cancelTask')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

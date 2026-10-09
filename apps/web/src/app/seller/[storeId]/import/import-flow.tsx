'use client';

import type { Route } from 'next';
import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { Button } from '@/components/ui/button';
import type { ImportView } from '@/lib/api/schemas';
import { importStatus, startImport } from '@/lib/seller/actions';

// Presentation timing: how often the screen asks for progress while an import runs.
const POLL_MS = 1_500;

type Stage =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'running'; view: ImportView }
  | { kind: 'done'; view: ImportView }
  | { kind: 'error'; message: string };

const FORMAT_OF: Record<string, 'csv' | 'xlsx' | 'zip'> = { csv: 'csv', xlsx: 'xlsx', zip: 'zip' };

/** Uploads one file as media kind `import` through this site's route; the media id, or the failure's code. */
async function uploadFile(
  file: File,
): Promise<{ ok: true; id: string } | { ok: false; code: string }> {
  const format = FORMAT_OF[file.name.split('.').pop()?.toLowerCase() ?? ''];
  if (!format) return { ok: false, code: 'UPLOAD_REJECTED' };
  const response = await fetch('/api/seller/import-file', {
    method: 'POST',
    headers: { 'x-file-format': format },
    body: file,
  }).catch(() => null);
  const body = (await response?.json().catch(() => ({}))) as
    { mediaId?: string; code?: string } | undefined;
  return response?.ok && body?.mediaId
    ? { ok: true, id: body.mediaId }
    : { ok: false, code: body?.code ?? 'NETWORK' };
}

/**
 * The bulk upload screen (ADR 056/057): pick the category, download its
 * template, upload the filled sheet (and a photos ZIP), run it as a dry run
 * or for real, watch the progress, read the row-by-row result and download
 * the report. The rows are the API's own Bengali reasons.
 */
export function ImportFlow({
  storeId,
  categories,
  recent,
}: {
  storeId: string;
  categories: { id: string; name: string }[];
  recent: ImportView[];
}) {
  const t = useTranslations('seller.import');
  const format = useFormatter();
  const [categoryId, setCategoryId] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const sheetRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const n = (value: number) => localizeDigits(String(value), 'bn');
  const files = (name: string, query = '') => `/seller/${storeId}/files/${name}${query}` as Route;

  const errorText = (code: string) =>
    t.has(`errors.${code}`)
      ? t(`errors.${code}`)
      : code === 'UPLOAD_REJECTED'
        ? t('errors.rejected')
        : t('errors.generic');

  useEffect(() => {
    if (stage.kind !== 'running') return;
    const timer = setTimeout(() => {
      void importStatus(storeId, stage.view.id).then((next) => {
        if (!next.ok) return setStage({ kind: 'error', message: errorText(next.code) });
        const finished = next.data.status === 'succeeded' || next.data.status === 'failed';
        setStage({ kind: finished ? 'done' : 'running', view: next.data });
      });
    }, POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-armed by each new view
  }, [stage, storeId]);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    const sheet = sheetRef.current?.files?.[0];
    const zip = zipRef.current?.files?.[0];
    if (!categoryId || !sheet) return;
    setStage({ kind: 'uploading' });
    const sheetUpload = await uploadFile(sheet);
    if (!sheetUpload.ok) return setStage({ kind: 'error', message: t('errors.upload') });
    let imagesMediaId: string | undefined;
    if (zip) {
      const zipUpload = await uploadFile(zip);
      if (!zipUpload.ok) return setStage({ kind: 'error', message: t('errors.upload') });
      imagesMediaId = zipUpload.id;
    }
    const started = await startImport(storeId, {
      categoryId,
      sheetMediaId: sheetUpload.id,
      ...(imagesMediaId ? { imagesMediaId } : {}),
      dryRun,
    });
    if (!started.ok) return setStage({ kind: 'error', message: errorText(started.code) });
    setStage({ kind: 'running', view: started.data });
  }

  const view = stage.kind === 'running' || stage.kind === 'done' ? stage.view : null;
  const total = view?.progress.totalRows ?? null;

  return (
    <div className="space-y-8">
      <form onSubmit={start} className="max-w-2xl space-y-4 rounded-lg border p-4">
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('category')}</span>
          <select
            required
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3"
          >
            <option value="">{t('chooseCategory')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {categoryId && (
          <p className="flex flex-wrap gap-3 text-sm">
            <a
              className="text-brand underline"
              href={files('template', `?categoryId=${categoryId}&format=xlsx`)}
            >
              {t('templateXlsx')}
            </a>
            <a
              className="text-brand underline"
              href={files('template', `?categoryId=${categoryId}&format=csv`)}
            >
              {t('templateCsv')}
            </a>
          </p>
        )}
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('sheet')}</span>
          <input
            ref={sheetRef}
            type="file"
            required
            accept=".csv,.xlsx"
            className="block w-full text-sm"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('images')}</span>
          <input ref={zipRef} type="file" accept=".zip" className="block w-full text-sm" />
          <span className="block text-xs text-muted-foreground">{t('imagesHint')}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(event) => setDryRun(event.target.checked)}
          />
          {t('dryRun')}
        </label>
        <Button type="submit" disabled={stage.kind === 'uploading' || stage.kind === 'running'}>
          {t('start')}
        </Button>
      </form>

      <div aria-live="polite" className="space-y-3">
        {stage.kind === 'uploading' && <p role="status">{t('uploading')}</p>}
        {stage.kind === 'error' && (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {stage.message}
          </p>
        )}
        {view && (
          <section className="space-y-3 rounded-lg border p-4">
            {view.status === 'queued' && <p role="status">{t('queued')}</p>}
            {view.status === 'running' && (
              <>
                <p role="status">
                  {total === null
                    ? t('runningUnknown', { done: n(view.progress.processedRows) })
                    : t('running', { done: n(view.progress.processedRows), total: n(total) })}
                </p>
                <progress
                  className="w-full"
                  value={view.progress.processedRows}
                  max={total ?? undefined}
                />
              </>
            )}
            {view.status === 'succeeded' && (
              <p role="status" className="font-medium">
                {t('succeeded', {
                  created: n(view.progress.created),
                  createdWord: view.dryRun ? t('validWord') : t('createdWord'),
                  skipped: n(view.progress.skipped),
                  failed: n(view.progress.failed),
                })}
              </p>
            )}
            {view.status === 'failed' && (
              <p role="alert" className="text-destructive">
                {t('failed', { reason: errorText(view.errorCode ?? 'generic') })}
              </p>
            )}
            {stage.kind === 'done' && (
              <>
                <a
                  className="text-sm text-brand underline"
                  href={files('report', `?importId=${view.id}`)}
                >
                  {t('report')}
                </a>
                {view.rows && view.rows.length > 0 && (
                  <table className="w-full text-sm">
                    <caption className="mb-2 text-left font-semibold">{t('rowsTitle')}</caption>
                    <thead>
                      <tr className="border-b text-left">
                        <th className="py-1 pr-3">{t('row')}</th>
                        <th className="py-1 pr-3">{t('outcome')}</th>
                        <th className="py-1">{t('reason')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.rows.map((row) => (
                        <tr key={row.row} className="border-b align-top">
                          <td className="py-1 pr-3 tabular-nums">{n(row.row)}</td>
                          <td
                            className={
                              row.outcome === 'failed' ? 'py-1 pr-3 text-destructive' : 'py-1 pr-3'
                            }
                          >
                            {t(`outcomes.${row.outcome}`)}
                          </td>
                          <td className="py-1">{row.reason ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </section>
        )}
      </div>

      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">{t('recent')}</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {recent.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  {localizeDigits(
                    format.dateTime(new Date(item.createdAt), {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    }),
                    'bn',
                  )}
                  {' · '}
                  {item.dryRun ? t('dry') : t('real')}
                  {' · '}
                  {t(`outcomes.created`)} {n(item.progress.created)}, {t('outcomes.failed')}{' '}
                  {n(item.progress.failed)}
                </span>
                <a className="text-brand underline" href={files('report', `?importId=${item.id}`)}>
                  {t('report')}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

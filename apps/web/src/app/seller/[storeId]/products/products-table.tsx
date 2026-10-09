'use client';

import { useMemo, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { formatMoney, localizeDigits, parseMoneyInput } from '@amar-elaka/dynamic-form';
import { DataTable, dataTableColumnHelper } from '@amar-elaka/ui/data-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  STOCK_STATUSES,
  type StockStatus,
  type StoreProduct,
  type StoreProducts,
} from '@/lib/api/schemas';
import {
  deletePost,
  markSold,
  repost,
  setHidden,
  setPrice,
  setStock,
  type ActionResult,
} from '@/lib/posts/actions';
import { postErrorMessage, type PostError } from '@/lib/posts/errors';
import { productsPage } from '@/lib/seller/actions';
import { BULK_ACTIONS, bulkEligible, runBulk, type BulkAction } from '@/lib/seller/bulk';

type Notice = { text: string; error: boolean; details?: string[] } | null;

/**
 * The seller panel's product table (ADR 057) on the shared DataTable: price
 * and stock edited in place, and bulk sold / hide / repost / delete for the
 * selected rows — each through the same post endpoints the app uses, one
 * row at a time, with the reason for every row that didn't go through.
 */
export function ProductsTable({ storeId, initial }: { storeId: string; initial: StoreProducts }) {
  const t = useTranslations('seller.products');
  const tErr = useTranslations('postErrors');
  const format = useFormatter();
  const [rows, setRows] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, startTransition] = useTransition();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StoreProduct[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const date = (iso: string) =>
    localizeDigits(format.dateTime(new Date(iso), { day: 'numeric', month: 'long' }), 'bn');
  const reason = (error: PostError) => {
    const message = postErrorMessage(error, date);
    return tErr(message.key, message.values);
  };

  async function reload() {
    const fresh = await productsPage(storeId);
    if (fresh.ok) {
      setRows(fresh.data.items);
      setCursor(fresh.data.nextCursor);
    }
  }

  function single(call: () => Promise<ActionResult<unknown>>) {
    startTransition(async () => {
      const result = await call();
      if (!result.ok) setNotice({ text: reason(result.error), error: true });
      else setNotice(null);
      await reload();
    });
  }

  function savePrice(product: StoreProduct, typed: string) {
    const price = parseMoneyInput(typed);
    if (!price) {
      setNotice({ text: t('priceInvalid'), error: true });
      return;
    }
    setEditing(null);
    single(() => setPrice(product.id, price));
  }

  function bulk(action: BulkAction, selected: StoreProduct[], clear: () => void) {
    const targets = selected.filter((p) => bulkEligible(p, action));
    if (targets.length === 0) return;
    if (action === 'delete' && confirmDelete === null) {
      setConfirmDelete(targets);
      return;
    }
    setConfirmDelete(null);
    startTransition(async () => {
      setProgress({ done: 0, total: targets.length });
      const call = (p: StoreProduct): Promise<ActionResult<unknown>> => {
        switch (action) {
          case 'markSold':
            return markSold(p.id, null);
          case 'hide':
            return setHidden(p.id, true);
          case 'unhide':
            return setHidden(p.id, false);
          case 'repost':
            return repost(p.id);
          case 'delete':
            return deletePost(p.id);
        }
      };
      const outcome = await runBulk(
        targets,
        async (p) => {
          const result = await call(p);
          return result.ok ? { ok: true } : { ok: false, error: result.error };
        },
        (done) => setProgress({ done, total: targets.length }),
      );
      setProgress(null);
      setNotice({
        text: t('bulkDone', {
          ok: localizeDigits(String(outcome.done.length), 'bn'),
          failed: localizeDigits(String(outcome.failed.length), 'bn'),
        }),
        error: outcome.failed.length > 0,
        details: outcome.failed.map((f) =>
          t('failedRow', { title: f.item.title, reason: reason(f.error) }),
        ),
      });
      clear();
      await reload();
    });
  }

  function loadMore() {
    if (!cursor) return;
    startTransition(async () => {
      const next = await productsPage(storeId, cursor);
      if (next.ok) {
        setRows((current) => [...current, ...next.data.items]);
        setCursor(next.data.nextCursor);
      }
    });
  }

  const columns = useMemo(() => {
    const helper = dataTableColumnHelper<StoreProduct>();
    return helper.columns([
      helper.accessor('title', {
        header: t('columns.title'),
        cell: ({ row }) => {
          const p = row.original;
          return (
            <div className="flex min-w-48 items-center gap-3">
              {p.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
                <img
                  src={p.thumbUrl}
                  alt=""
                  width={40}
                  height={40}
                  className="size-10 rounded object-cover"
                />
              ) : (
                <span className="size-10 rounded bg-muted" aria-hidden />
              )}
              <span className="font-medium">{p.title}</span>
              {!p.isMine && (
                <span className="text-xs text-muted-foreground">({t('notYours')})</span>
              )}
            </div>
          );
        },
      }),
      helper.accessor((p) => p.price ?? '', {
        id: 'price',
        header: t('columns.price'),
        cell: ({ row }) => {
          const p = row.original;
          if (editing?.id === p.id) {
            return (
              <form
                className="flex items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  savePrice(p, editing.value);
                }}
              >
                <Input
                  aria-label={t('editPrice')}
                  inputMode="decimal"
                  autoFocus
                  value={editing.value}
                  onChange={(event) => setEditing({ id: p.id, value: event.target.value })}
                  className="h-8 w-28"
                />
                <Button type="submit" size="sm" disabled={busy}>
                  {t('savePrice')}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  {t('cancel')}
                </Button>
              </form>
            );
          }
          const label = p.price ? `৳ ${formatMoney(p.price, 'bn')}` : '—';
          return p.canManage && p.status !== 'sold' ? (
            <button
              type="button"
              className="rounded px-1 tabular-nums underline decoration-dotted underline-offset-4 hover:bg-muted"
              aria-label={`${t('editPrice')}: ${p.title}`}
              onClick={() =>
                setEditing({
                  id: p.id,
                  value: p.price ? localizeDigits(p.price.replace(/\.00$/, ''), 'bn') : '',
                })
              }
            >
              {label}
            </button>
          ) : (
            <span className="tabular-nums">{label}</span>
          );
        },
      }),
      helper.accessor('status', {
        header: t('columns.status'),
        cell: ({ row }) => (
          <span>
            {t(`status.${row.original.status}`)}
            {row.original.hidden && (
              <span className="ml-1 text-xs text-muted-foreground">· {t('hidden')}</span>
            )}
          </span>
        ),
      }),
      helper.accessor('stockStatus', {
        header: t('columns.stock'),
        cell: ({ row }) => {
          const p = row.original;
          if (!p.canManage) return t(`stock.${p.stockStatus}`);
          return (
            <select
              aria-label={`${t('columns.stock')}: ${p.title}`}
              value={p.stockStatus}
              disabled={busy}
              onChange={(event) => single(() => setStock(p.id, event.target.value as StockStatus))}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            >
              {STOCK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`stock.${s}`)}
                </option>
              ))}
            </select>
          );
        },
      }),
      helper.accessor('views', {
        header: t('columns.views'),
        cell: ({ getValue }) => (
          <span className="tabular-nums">{localizeDigits(String(getValue()), 'bn')}</span>
        ),
      }),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when an edit opens or the busy state flips
  }, [editing, busy, t]);

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('count', { count: localizeDigits(String(rows.length), 'bn') })}
      </p>
      {notice && (
        <div
          role={notice.error ? 'alert' : 'status'}
          className={
            notice.error
              ? 'rounded-md bg-destructive/10 p-3 text-sm text-destructive'
              : 'rounded-md bg-muted p-3 text-sm'
          }
        >
          <p>{notice.text}</p>
          {notice.details && notice.details.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {notice.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {progress && (
        <p role="status" className="text-sm">
          {t('working', {
            done: localizeDigits(String(progress.done), 'bn'),
            total: localizeDigits(String(progress.total), 'bn'),
          })}
        </p>
      )}
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(p) => p.id}
        enableSelection
        canSelectRow={(p) => p.canManage}
        exportFilename="products"
        renderBulkActions={(selected, clear) => (
          <div className="flex flex-wrap items-center gap-2">
            {confirmDelete ? (
              <>
                <span className="text-sm">
                  {t('confirmDelete', {
                    count: localizeDigits(String(confirmDelete.length), 'bn'),
                  })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  disabled={busy}
                  onClick={() => bulk('delete', selected, clear)}
                >
                  {t('confirm')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                  {t('cancel')}
                </Button>
              </>
            ) : (
              BULK_ACTIONS.map((action) => {
                const count = selected.filter((p) => bulkEligible(p, action)).length;
                return (
                  <Button
                    key={action}
                    size="sm"
                    variant="outline"
                    className={action === 'delete' ? 'text-destructive' : undefined}
                    disabled={busy || count === 0}
                    onClick={() => bulk(action, selected, clear)}
                  >
                    {t(`bulk.${action}`)}
                    {count > 0 && ` (${localizeDigits(String(count), 'bn')})`}
                  </Button>
                );
              })
            )}
          </div>
        )}
      />
      {cursor && (
        <Button variant="outline" onClick={loadMore} disabled={busy}>
          {t('more')}
        </Button>
      )}
    </section>
  );
}

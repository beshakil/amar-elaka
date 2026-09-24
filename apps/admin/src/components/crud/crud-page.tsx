'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { RowData } from '@tanstack/react-table';
import {
  DataTable,
  dataTableColumnHelper,
  type DataTableColumns,
} from '@/components/data-table/data-table';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useConfirm } from '@/components/ui/confirm';
import type { ActionResult } from '@/lib/action-result';

export interface CrudPageProps<TData extends RowData> {
  title: string;
  description?: string;
  columns: DataTableColumns<TData>;
  rows: TData[];
  getRowId: (row: TData) => string;
  exportFilename?: string;
  /**
   * The create form. Rendered in a side sheet; calls `close` on success. Omit
   * when the API has no create endpoint for this entity, or the viewer may not
   * create one — the button then does not appear at all, rather than opening a
   * form that cannot submit.
   */
  renderCreateForm?: (close: () => void) => React.ReactNode;
  /** Same, for one existing row. */
  renderEditForm?: (row: TData, close: () => void) => React.ReactNode;
  /** Omit when there is no delete endpoint or permission; the row action and bulk delete go with it. */
  onDelete?: (row: TData) => Promise<ActionResult>;
  /** Rows that may be edited — e.g. not a built-in record. Defaults to all. */
  canEdit?: (row: TData) => boolean;
  /** Rows that may be deleted, individually or in bulk. Defaults to all. */
  canDelete?: (row: TData) => boolean;
  /** Extra per-row actions, appended before edit/delete. */
  renderRowActions?: (row: TData) => React.ReactNode;
}

const always = (): boolean => true;

/**
 * List + create + edit + delete for one entity, so a module supplies columns,
 * rows and forms rather than rebuilding the same page. Every mutating slot is
 * optional on purpose: an entity whose API only supports reading and creating
 * gets exactly those affordances, not disabled buttons for endpoints that do
 * not exist.
 *
 * Data arrives already fetched from a Server Component; after a mutation this
 * calls `router.refresh()` so the server refetches rather than this holding a
 * second copy of the list in client state.
 */
export function CrudPage<TData extends RowData>({
  title,
  description,
  columns,
  rows,
  getRowId,
  exportFilename,
  renderCreateForm,
  renderEditForm,
  onDelete,
  canEdit = always,
  canDelete = always,
  renderRowActions,
}: CrudPageProps<TData>) {
  const t = useTranslations('crud');
  const tError = useTranslations('apiError');
  const router = useRouter();
  const confirm = useConfirm();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TData | null>(null);
  const [isPending, startTransition] = useTransition();

  function closeAndRefresh() {
    setIsCreateOpen(false);
    setEditing(null);
    startTransition(() => router.refresh());
  }

  async function remove(row: TData) {
    if (!onDelete) return;
    const confirmed = await confirm({
      title: t('deleteTitle'),
      description: t('deleteDescription'),
      confirmLabel: t('delete'),
    });
    if (!confirmed) return;

    const result = await onDelete(row);
    if (result.ok) {
      toast.success(t('deleted'));
      startTransition(() => router.refresh());
    } else {
      toast.error(tError(result.messageKey));
    }
  }

  async function removeMany(selected: TData[], clearSelection: () => void) {
    if (!onDelete) return;
    const targets = selected.filter(canDelete);
    const confirmed = await confirm({
      title: t('deleteManyTitle', { count: targets.length }),
      description: t('deleteDescription'),
      confirmLabel: t('delete'),
    });
    if (!confirmed) return;

    // One at a time: the API has no bulk endpoint, and sequential calls keep a
    // partial failure attributable instead of racing N writes.
    let deleted = 0;
    let firstFailure: string | null = null;
    for (const row of targets) {
      const result = await onDelete(row);
      if (result.ok) deleted += 1;
      else firstFailure ??= result.messageKey;
    }

    if (deleted > 0) toast.success(t('deletedCount', { count: deleted }));
    if (firstFailure) toast.error(tError(firstFailure));
    clearSelection();
    startTransition(() => router.refresh());
  }

  const hasRowActions =
    renderEditForm !== undefined || onDelete !== undefined || renderRowActions !== undefined;

  const helper = dataTableColumnHelper<TData>();
  const columnsWithActions = hasRowActions
    ? helper.columns([
        ...columns,
        helper.display({
          id: 'actions',
          header: t('actions'),
          enableSorting: false,
          enableHiding: false,
          cell: ({ row }) => (
            <div className="flex justify-end gap-1">
              {renderRowActions?.(row.original)}
              {renderEditForm && canEdit(row.original) ? (
                <Button variant="ghost" size="sm" onClick={() => setEditing(row.original)}>
                  {t('edit')}
                </Button>
              ) : null}
              {onDelete && canDelete(row.original) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => void remove(row.original)}
                >
                  {t('delete')}
                </Button>
              ) : null}
            </div>
          ),
        }),
      ])
    : columns;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description ? <p className="mt-1 text-muted-foreground">{description}</p> : null}
      </div>

      <DataTable
        columns={columnsWithActions}
        data={rows}
        getRowId={getRowId}
        enableSelection={onDelete !== undefined}
        canSelectRow={canDelete}
        {...(exportFilename ? { exportFilename } : {})}
        toolbar={
          renderCreateForm ? (
            <Button size="sm" onClick={() => setIsCreateOpen(true)}>
              <Plus className="size-4" aria-hidden />
              {t('create')}
            </Button>
          ) : null
        }
        {...(onDelete
          ? {
              renderBulkActions: (selected: TData[], clearSelection: () => void) => (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={() => void removeMany(selected, clearSelection)}
                >
                  <Trash2 className="size-4" aria-hidden />
                  {t('deleteSelected')}
                </Button>
              ),
            }
          : {})}
      />

      {renderCreateForm ? (
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogContent closeLabel={t('close')}>
            <DialogTitle>{t('createTitle', { entity: title })}</DialogTitle>
            <DialogDescription>{t('createDescription')}</DialogDescription>
            {renderCreateForm(closeAndRefresh)}
          </DialogContent>
        </Dialog>
      ) : null}

      {renderEditForm ? (
        <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent closeLabel={t('close')}>
            <DialogTitle>{t('editTitle', { entity: title })}</DialogTitle>
            {editing ? renderEditForm(editing, closeAndRefresh) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

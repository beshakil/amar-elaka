'use client';

import { useMemo } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
  type ColumnHelper,
  type RowData,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { downloadCsv, toCsv } from './csv';

// Only the features this table actually uses: v9 requires each one to be
// registered before its APIs exist, which is also what keeps the bundle honest.
const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric },
});

export type DataTableFeatures = typeof features;

/**
 * Build columns with this helper so each column keeps its own value type —
 * `helper.columns([...])` is what preserves it (a plain array widens).
 */
export function dataTableColumnHelper<TData extends RowData>(): ColumnHelper<
  DataTableFeatures,
  TData
> {
  return createColumnHelper<DataTableFeatures, TData>();
}

export type DataTableColumns<TData extends RowData> = ReturnType<
  ColumnHelper<DataTableFeatures, TData>['columns']
>;

// Page sizes offered in the footer. A view preference, not a business limit.
const PAGE_SIZES = [10, 25, 50, 100];

export interface DataTableProps<TData extends RowData> {
  columns: DataTableColumns<TData>;
  data: TData[];
  /** Stable row identity; falls back to the row index. */
  getRowId?: (row: TData) => string;
  /** Adds the checkbox column and the selection summary bar. */
  enableSelection?: boolean;
  /** Rows that may be selected; the rest get a disabled checkbox. */
  canSelectRow?: (row: TData) => boolean;
  /** Base name for the exported file, without the .csv suffix. */
  exportFilename?: string;
  /** Rendered in the toolbar, e.g. a "new role" button. */
  toolbar?: React.ReactNode;
  /** Rendered above the table when rows are selected. */
  renderBulkActions?: (selected: TData[], clearSelection: () => void) => React.ReactNode;
}

/**
 * The one table every admin module renders. It owns sorting, filtering,
 * pagination, selection, column visibility and CSV export so no module
 * reimplements them; everything module-specific arrives as columns and slots.
 *
 * Client-side models throughout: every list this dashboard serves today is
 * small enough to send whole, and no list endpoint paginates yet.
 */
export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  enableSelection = false,
  canSelectRow,
  exportFilename = 'export',
  toolbar,
  renderBulkActions,
}: DataTableProps<TData>) {
  const t = useTranslations('dataTable');
  const format = useFormatter();
  const helper = useMemo(() => dataTableColumnHelper<TData>(), []);

  const resolvedColumns = useMemo(() => {
    if (!enableSelection) return columns;
    const selectColumn = helper.display({
      id: 'select',
      enableSorting: false,
      enableHiding: false,
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected()
              ? true
              : // v9's "some" means at least one, including all — the
                // indeterminate box needs the explicit pair.
                table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()
                ? 'indeterminate'
                : false
          }
          onCheckedChange={(checked) => table.toggleAllPageRowsSelected(checked === true)}
          aria-label={t('selectAll')}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onCheckedChange={(checked) => row.toggleSelected(checked === true)}
          aria-label={t('selectRow')}
        />
      ),
    });
    return helper.columns([selectColumn, ...columns]);
  }, [columns, enableSelection, helper, t]);

  const table = useTable({
    features,
    columns: resolvedColumns,
    data,
    enableRowSelection:
      enableSelection && canSelectRow
        ? (row: { original: TData }) => canSelectRow(row.original)
        : enableSelection,
    ...(getRowId ? { getRowId: (row: TData) => getRowId(row) } : {}),
  });

  const selectedRows = table.getSelectedRowModel().rows.map((row) => row.original);

  function exportCsv() {
    // Only data columns: display columns (selection, row actions) have no
    // value to export and would otherwise become empty CSV columns.
    const visibleColumns = table
      .getVisibleLeafColumns()
      .filter((column) => column.accessorFn !== undefined);
    const headers = visibleColumns.map((column) =>
      typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id,
    );
    const rows = table
      .getFilteredRowModel()
      .rows.map((row) => visibleColumns.map((column) => row.getValue(column.id)));
    downloadCsv(`${exportFilename}.csv`, toCsv(headers, rows));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          // `globalFilter` is typed loosely by the library (any value a custom
          // filter fn might accept); this table only ever puts a string in it.
          value={typeof table.state.globalFilter === 'string' ? table.state.globalFilter : ''}
          onChange={(event) => table.setGlobalFilter(event.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          className="max-w-xs"
        />

        <div className="ms-auto flex items-center gap-2">
          {toolbar}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Settings2 className="size-4" aria-hidden />
                {t('columns')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('columns')}</DropdownMenuLabel>
              {table
                .getAllLeafColumns()
                .filter((column) => column.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(checked) => column.toggleVisibility(checked)}
                  >
                    {typeof column.columnDef.header === 'string'
                      ? column.columnDef.header
                      : column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="size-4" aria-hidden />
            {t('exportCsv')}
          </Button>
        </div>
      </div>

      {enableSelection && selectedRows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
          <span>{t('selectedCount', { count: selectedRows.length })}</span>
          {renderBulkActions?.(selectedRows, () => table.resetRowSelection())}
          <Button variant="ghost" size="sm" onClick={() => table.resetRowSelection()}>
            {t('clearSelection')}
          </Button>
        </div>
      ) : null}

      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sorted = header.column.getIsSorted();
                return (
                  <TableHead key={header.id} aria-sort={ariaSort(sorted)}>
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        <table.FlexRender header={header} />
                        {sorted === 'asc' ? (
                          <ArrowUp className="size-3" aria-hidden />
                        ) : sorted === 'desc' ? (
                          <ArrowDown className="size-3" aria-hidden />
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-50" aria-hidden />
                        )}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={table.getVisibleLeafColumns().length}
                className="py-10 text-center text-muted-foreground"
              >
                {t('empty')}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} data-selected={row.getIsSelected()}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">
          {t('rowCount', { count: table.getFilteredRowModel().rows.length })}
        </span>

        <div className="flex items-center gap-2">
          <select
            value={table.state.pagination?.pageSize ?? PAGE_SIZES[0]}
            onChange={(event) => table.setPageSize(Number(event.target.value))}
            aria-label={t('rowsPerPage')}
            className="h-8 rounded-md border border-input bg-background px-2"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {format.number(size)}
              </option>
            ))}
          </select>

          <span className="text-muted-foreground">
            {t('pageOf', {
              page: (table.state.pagination?.pageIndex ?? 0) + 1,
              total: Math.max(1, table.getPageCount()),
            })}
          </span>

          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            {t('previous')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            {t('next')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ariaSort(sorted: false | 'asc' | 'desc'): 'ascending' | 'descending' | undefined {
  if (sorted === 'asc') return 'ascending';
  if (sorted === 'desc') return 'descending';
  return undefined;
}

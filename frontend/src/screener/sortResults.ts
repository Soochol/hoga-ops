import { sortEntriesByChangePct, type QuoteSortMode } from '../rightrail/quoteSort';

export type ScreenerResultSortMode = QuoteSortMode;

type SortableScreenerRow = {
  code: string;
  change_pct: number | null | undefined;
  change_pct_sort?: number | null | undefined;
};

function normalizeChangePct(changePct: unknown): number | null {
  return typeof changePct === 'number' && Number.isFinite(changePct) ? changePct : null;
}

function changePctForSort(row: SortableScreenerRow): number | null {
  if (Object.prototype.hasOwnProperty.call(row, 'change_pct_sort')) {
    return normalizeChangePct(row.change_pct_sort);
  }
  return normalizeChangePct(row.change_pct);
}

export function sortScreenerRows<T extends SortableScreenerRow>(
  rows: readonly T[],
  mode: ScreenerResultSortMode,
): T[] {
  if (mode === 'default') {
    return [...rows];
  }

  const sortable = rows.map((row, order) => {
    const syntheticCode = `${order}:${row.code}`;
    return { row, code: syntheticCode, order };
  });

  const pctBySyntheticCode = new Map<string, number | null>(
    sortable.map(({ code, row }) => [code, changePctForSort(row)]),
  );

  return sortEntriesByChangePct(
    sortable,
    (code) => pctBySyntheticCode.get(code) ?? null,
    mode,
  ).map((entry) => entry.row);
}

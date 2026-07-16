export type ScreenerResultSortField = 'code' | 'name' | 'market' | 'price' | 'change_pct' | 'trade_value_won';
export type ScreenerResultSortDirection = 'asc' | 'desc';
export type ScreenerResultSortMode =
  | 'default'
  | { field: ScreenerResultSortField; direction: ScreenerResultSortDirection };

type SortableScreenerRow = {
  code: string;
  name?: string | null | undefined;
  market?: string | null | undefined;
  price?: number | null | undefined;
  trade_value_won?: number | null | undefined;
  change_pct: number | null | undefined;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function normalizeChangePct(changePct: unknown): number | null {
  return typeof changePct === 'number' && Number.isFinite(changePct) ? changePct : null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function valueForSort(row: SortableScreenerRow, field: ScreenerResultSortField): number | string | null {
  if (field === 'change_pct') return normalizeChangePct(row.change_pct);
  if (field === 'price') return normalizeNumber(row.price);
  if (field === 'trade_value_won') return normalizeNumber(row.trade_value_won);
  if (field === 'code') return normalizeText(row.code);
  if (field === 'name') return normalizeText(row.name);
  return normalizeText(row.market);
}

export function sortScreenerRows<T extends SortableScreenerRow>(
  rows: readonly T[],
  mode: ScreenerResultSortMode,
): T[] {
  if (mode === 'default') {
    return [...rows];
  }

  const dir = mode.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, order) => ({ row, order, value: valueForSort(row, mode.field) }))
    .sort((a, b) => {
      if (a.value == null && b.value == null) return a.order - b.order;
      if (a.value == null) return 1;
      if (b.value == null) return -1;

      const byValue = typeof a.value === 'number' && typeof b.value === 'number'
        ? a.value - b.value
        : collator.compare(String(a.value), String(b.value));
      return byValue === 0 ? a.order - b.order : byValue * dir;
    })
    .map((entry) => entry.row);
}

export function nextScreenerSortMode(
  mode: ScreenerResultSortMode,
  field: ScreenerResultSortField,
): ScreenerResultSortMode {
  if (mode === 'default' || mode.field !== field) return { field, direction: 'asc' };
  if (mode.direction === 'asc') return { field, direction: 'desc' };
  return 'default';
}

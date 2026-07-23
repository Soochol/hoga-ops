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

/**
 * 진입 순번(gen) 기반 안정 정렬 — 실시간 모니터링 드로어 전용. `default` 모드에서
 * 서버 응답 순서를 그대로 쓰면 재조회마다 행이 요동치므로, 대신 각 종목이 결과 집합에
 * **처음 편입된 세대(gen)**로 정렬한다. gen 이 큰(= 나중에 새로 들어온) 종목이 위로
 * 쌓이고(상단 스택), 같은 gen 안에서는 원래 서버 순서를 유지한다 — 기존 종목의 상대
 * 위치가 고정되는 효과.
 *
 * gen 은 useEntryOrder 가 code→gen 으로 넘긴다. 첫 배치는 전부 gen 0 이라 서버순이
 * 그대로 보존되고, 이후 tick 의 신규만 더 큰 gen 을 받아 위로 올라온다. 맵에 없는
 * 코드는 0 으로 간주(방어). sortScreenerRows 와 동일하게 입력을 변형하지 않는다.
 */
export function stackByEntryOrder<T extends { code: string }>(
  rows: readonly T[],
  orderMap: ReadonlyMap<string, number>,
): T[] {
  return rows
    .map((row, order) => ({ row, order, gen: orderMap.get(row.code) ?? 0 }))
    .sort((a, b) => (b.gen - a.gen) || (a.order - b.order))
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

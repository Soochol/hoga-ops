import type { ScreenerRowLive } from './useScreenerRowsLive';
import { dispositionFromMouseEvent, type LiveOpenDisposition } from '../live/liveActivation';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';
import { nextScreenerSortMode, type ScreenerResultSortField, type ScreenerResultSortMode } from './sortResults';
import { DataTableHeader, DataTableRow, DataTableShell, EmptyState } from '../ui/DataSurface';
import { priceDirClass } from '../ui/priceDir';

interface Props {
  /** Live Quote 가 이미 머지된 결과 행(useScreenerRowsLive). 표시만 하면 된다. */
  rows: ScreenerRowLive[];
  onActivate: (code: string, name?: string, options?: { disposition?: LiveOpenDisposition }) => void;
  sortMode?: ScreenerResultSortMode;
  onSortChange?: (mode: ScreenerResultSortMode) => void;
  embedded?: boolean;
}

const COLS = 'grid-cols-[3.5rem_1fr_4rem_8.5rem_6rem_2.4rem]';
/** Won → 억 (100M), rounded to whole 억 for the table — matches the filter
 *  unit (거래대금 하한 is entered in 억). */
const toEok = (won: number) => Math.round(won / 1e8).toLocaleString('ko-KR');

const HEADERS: Array<{ field: ScreenerResultSortField; label: string; sortLabel?: string; align?: 'right' }> = [
  { field: 'code', label: '코드' },
  { field: 'name', label: '종목명' },
  { field: 'market', label: '시장' },
  { field: 'price', label: '현재가(등락률)', sortLabel: '현재가', align: 'right' },
  { field: 'trade_value_won', label: '거래대금(억)', align: 'right' },
];

function formatPct(pct: number | null): string {
  if (pct === null) return '—';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function SortHeader({ field, label, sortLabel = label, align, sortMode = 'default', onSortChange }: {
  field: ScreenerResultSortField;
  label: string;
  sortLabel?: string;
  align?: 'right';
  sortMode?: ScreenerResultSortMode;
  onSortChange?: (mode: ScreenerResultSortMode) => void;
}) {
  const active = sortMode !== 'default' && sortMode.field === field;
  const arrow = active ? (sortMode.direction === 'asc' ? '▲' : '▼') : '↕';
  return (
    <button
      type="button"
      aria-label={`${sortLabel} 정렬`}
      onClick={() => onSortChange?.(nextScreenerSortMode(sortMode, field))}
      className={`min-w-0 inline-flex items-center gap-1 bg-transparent border-0 p-0 text-xs font-semibold uppercase tracking-[0.06em] ${
        align === 'right' ? 'justify-end text-right' : 'justify-start text-left'
      } ${active ? 'text-accent' : 'text-fg-dimmer hover:text-fg'}`}
    >
      <span className="truncate">{label}</span>
      <span className="font-mono text-[10px]" aria-hidden="true">{arrow}</span>
    </button>
  );
}

export function ResultTable({ rows, onActivate, sortMode = 'default', onSortChange, embedded = false }: Props) {
  return (
    <DataTableShell
      minWidth="640px"
      className={embedded ? 'flex-1 border-0 rounded-none bg-transparent' : ''}
    >
      <DataTableHeader columns={COLS}>
        {HEADERS.map((header) => (
          <SortHeader key={header.field} {...header} sortMode={sortMode} onSortChange={onSortChange} />
        ))}
        <span className="text-right text-xs font-semibold uppercase tracking-[0.06em] text-fg-dimmer">액션</span>
      </DataTableHeader>
      <div className="flex-1 min-h-0">
        {rows.length === 0 ? (
          <EmptyState className="items-start justify-start p-md text-left">조건에 맞는 종목이 없습니다.</EmptyState>
        ) : rows.map((r) => {
          const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(r.code, r.name); }
          };
          return (
            <DataTableRow key={r.code} role="button" tabIndex={0} aria-label={`${r.name} ${r.code} 호가창 열기`}
              onClick={(e) => onActivate(r.code, r.name, { disposition: dispositionFromMouseEvent(e) })} onKeyDown={onKeyDown}
              columns={COLS}
              className="cursor-pointer outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover">
              <span className="font-mono tabular-nums text-fg-dim">{r.code}</span>
              <span className="truncate">{r.name}</span>
              <span className="font-mono text-xs text-fg-dim">{r.market}</span>
              <span className={`font-mono tabular-nums text-right ${r.change_pct === null ? '' : priceDirClass(r.change_pct)}`}>
                {r.price != null ? `${r.price.toLocaleString('ko-KR')} (${formatPct(r.change_pct)})` : '—'}
              </span>
              <span className="font-mono tabular-nums text-right text-fg-dim">{toEok(r.trade_value_won)}</span>
              <span className="flex items-center justify-end gap-2">
                <WatchlistHeartButton code={r.code} name={r.name} variant="row" />
              </span>
            </DataTableRow>
          );
        })}
      </div>
    </DataTableShell>
  );
}

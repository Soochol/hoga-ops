import type { ScreenerRowLive } from './useScreenerRowsLive';
import type { DepthPeakValue } from '../api/screener';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';
import { nextScreenerSortMode, type ScreenerResultSortField, type ScreenerResultSortMode } from './sortResults';
import { DataTableHeader, DataTableRow, DataTableShell, EmptyState } from '../ui/DataSurface';
import { priceDirClass } from '../ui/priceDir';
import type { JumpModifiers } from '../live/useJumpToLive';

interface Props {
  /** Live Quote 가 이미 머지된 결과 행(useScreenerRowsLive). 표시만 하면 된다. */
  rows: ScreenerRowLive[];
  onActivate: (code: string, name?: string, e?: JumpModifiers) => void;
  sortMode?: ScreenerResultSortMode;
  onSortChange?: (mode: ScreenerResultSortMode) => void;
  embedded?: boolean;
  /** 총잔량 신고 조건이 있을 때만: code→당일/과거 peak. 결과행 검증 배지. */
  depthValues?: Record<string, DepthPeakValue> | null;
  /** 활성 총잔량 조건의 side. 배지가 통과를 좌우한 side만 표시하도록. */
  depthSides?: DepthSides;
}

/** 활성화된 총잔량 조건의 side(매도/매수). evaluate 는 code 마다 양쪽을 모두 채우므로,
 *  배지는 실제로 통과를 좌우한 side 만 보여줘야 한다(매수 조건인데 매도 값 표시 방지). */
export interface DepthSides { ask: boolean; bid: boolean }

const fmtQty = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('ko-KR'));

/** 결과행의 총잔량 peak 배지 — side별 당일/과거 값 + 부분 커버리지(N/M일). /live 총잔량
 *  pane 의 intra-bar max 와 같은 값이라 사용자가 눈으로 대조할 수 있다. */
function DepthBadge({ v, sides }: { v: DepthPeakValue; sides: DepthSides }) {
  // 조건에 있는 side만. 둘 다면 매도·매수 각각 표시(어느 쪽이 통과를 좌우했는지 명확).
  // 각 side는 자기 leaf N 기준(혼합 N 스크린에서 과거 peak·부분커버리지가 정확).
  interface Row { label: string; today: number | null; past: number | null; have: number; need: number }
  const rows: Row[] = [];
  if (sides.ask) rows.push({ label: '매도', today: v.ask_today, past: v.ask_past_peak, have: v.ask_have_days, need: v.ask_need_days });
  if (sides.bid) rows.push({ label: '매수', today: v.bid_today, past: v.bid_past_peak, have: v.bid_have_days, need: v.bid_need_days });
  if (rows.length === 0 || rows.every((r) => r.today == null && r.past == null)) return null;
  const isPartial = (r: Row) => r.have > 0 && r.have < r.need;
  const title = rows
    .map((r) => `${r.label} 당일 peak ${fmtQty(r.today)} · 지난 ${r.need}일 peak ${fmtQty(r.past)}`)
    .join(' / ');
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-fg-dimmer" title={title}>
      {rows.map((r) => (
        <span key={r.label} className="inline-flex items-center gap-1">
          {rows.length > 1 && <span className="text-fg-dimmer">{r.label}</span>}
          <span>{fmtQty(r.today)}/{fmtQty(r.past)}</span>
          {isPartial(r) && (
            <span className="rounded-sm px-1" style={{ color: 'var(--warn)', background: 'var(--tint-selection)' }}>
              {r.have}/{r.need}일
            </span>
          )}
        </span>
      ))}
    </span>
  );
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

export function ResultTable({ rows, onActivate, sortMode = 'default', onSortChange, embedded = false, depthValues, depthSides }: Props) {
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
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(r.code, r.name, e); }
          };
          return (
            <DataTableRow key={r.code} role="button" tabIndex={0} aria-label={`${r.name} ${r.code} 호가창 열기`}
              onClick={(e) => onActivate(r.code, r.name, e)} onKeyDown={onKeyDown}
              columns={COLS}
              className="cursor-pointer outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover">
              <span className="font-mono tabular-nums text-fg-dim">{r.code}</span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{r.name}</span>
                {depthValues?.[r.code] && depthSides && <DepthBadge v={depthValues[r.code]} sides={depthSides} />}
              </span>
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

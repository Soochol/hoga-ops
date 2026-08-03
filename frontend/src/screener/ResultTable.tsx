import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ScreenerRowLive } from './useScreenerRowsLive';
import type { DepthPeakValue } from '../api/screener';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
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
 *  배지는 실제로 통과를 좌우한 side 만 보여줘야 한다(매수 조건인데 매도 값 표시 방지).
 *  `askRenewal` 은 기준시각 돌파 조건 — peak 조건과 숫자의 의미가 달라 별도 배지다. */
export interface DepthSides { ask: boolean; bid: boolean; askRenewal?: boolean }

const fmtQty = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('ko-KR'));
const fmtHhmm = (hhmm: number | null | undefined) =>
  (hhmm == null ? '' : `${String(Math.floor(hhmm / 100)).padStart(2, '0')}:${String(hhmm % 100).padStart(2, '0')}`);

/** 기준시각 돌파 배지 — 기준시각 이전 최대 → 이후 최대. peak 배지와 문구가 다른 이유는
 *  숫자가 다른 것을 뜻하기 때문이다(저쪽은 "지난 N일 peak", 이쪽은 같은 날 두 구간). */
function DepthRenewalBadge({ v }: { v: DepthPeakValue }) {
  const pre = v.ask_pre_max;
  const post = v.ask_post_max;
  if (pre == null && post == null) return null;
  const at = fmtHhmm(v.renewal_start_hhmm);
  return (
    <span className="inline-flex items-center gap-1 font-data text-[10px] tabular-nums text-fg-dimmer"
      title={`${at} 이전 최대 매도 총잔량 ${fmtQty(pre)} → 이후 최대 ${fmtQty(post)}`}>
      <span className="text-fg-dimmer">{at}</span>
      <span>{fmtQty(pre)}→{fmtQty(post)}</span>
    </span>
  );
}

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
    <span className="inline-flex items-center gap-1.5 font-data text-[10px] tabular-nums text-fg-dimmer" title={title}>
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

/** 이 줄 수를 넘으면 가상화한다. CaptureQueue 의 임계와 같은 값 — 그보다 작으면
 *  DOM 을 다 그려도 재렌더가 10ms 안쪽이고(실측 100행 8ms), 가상화는 스크롤 위치
 *  복원·측정 같은 부수 복잡도를 들여온다. 백엔드는 `LIMIT 1000` 이라 상한이 있다. */
const VIRTUALIZE_THRESHOLD = 200;
/** 행 1개의 초기 추정 높이(px). 실제 높이는 measureElement 로 되읽는다 —
 *  총잔량 배지가 붙은 행은 더 높다. */
const ROW_ESTIMATE_PX = 28;
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
      className={`min-w-0 inline-flex items-center gap-1 bg-transparent border-0 p-0 text-xs font-semibold uppercase ${
        align === 'right' ? 'justify-end text-right' : 'justify-start text-left'
      } ${active ? 'text-accent' : 'text-fg-dimmer hover:text-fg'}`}
    >
      <span className="truncate">{label}</span>
      <span className="font-data text-[10px]" aria-hidden="true">{arrow}</span>
    </button>
  );
}

/** 행 하나 — 평면 렌더와 가상 렌더가 **같은 마크업**을 쓰도록 뽑아냈다.
 *  둘이 갈라지면 가상화가 켜지는 임계(200행) 위아래에서 화면이 달라진다. */
function ResultRow({ r, isMember, onActivate, depthValues, depthSides, style, measureRef }: {
  r: ScreenerRowLive;
  isMember: (code: string) => boolean;
  onActivate: Props['onActivate'];
  depthValues?: Record<string, DepthPeakValue> | null;
  depthSides?: DepthSides;
  style?: React.CSSProperties;
  measureRef?: (el: HTMLElement | null) => void;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(r.code, r.name, e); }
  };
  return (
    <DataTableRow role="button" tabIndex={0} aria-label={`${r.name} ${r.code} 호가창 열기`}
      rowRef={measureRef} style={style}
      onClick={(e) => onActivate(r.code, r.name, e)} onKeyDown={onKeyDown}
      columns={COLS}
      className="cursor-pointer outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover">
      <span className="font-data tabular-nums text-fg-dim">{r.code}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{r.name}</span>
        {depthValues?.[r.code] && depthSides && <DepthBadge v={depthValues[r.code]} sides={depthSides} />}
        {depthValues?.[r.code] && depthSides?.askRenewal && <DepthRenewalBadge v={depthValues[r.code]} />}
      </span>
      <span className="font-data text-xs text-fg-dim">{r.market}</span>
      {/* 동시호가 중엔 예상체결가/등락률로 대체('예' 마커, QuoteRow·HeatmapRow 와
          동일 규칙) — 창 밖·체결 후엔 expected_* 가 사라져 자동 복귀. */}
      {r.expected_price != null ? (
        // 마감 동시호가엔 확정가가 예상가에 덮인다 — QuoteRow 와 동일하게
        // 직전 체결가를 title 로 보존한다(표에도 두 숫자를 나란히 둘 폭이 없다).
        <span
          title={r.price != null
            ? `예상 ${r.expected_price.toLocaleString('ko-KR')} · 직전 체결 ${r.price.toLocaleString('ko-KR')}`
            : undefined}
          className={`font-data tabular-nums text-right ${r.expected_change_pct == null ? '' : priceDirClass(r.expected_change_pct)}`}
        >
          <span className="mr-0.5 text-[10px] text-fg-dimmer">예</span>
          {`${r.expected_price.toLocaleString('ko-KR')} (${formatPct(r.expected_change_pct ?? null)})`}
        </span>
      ) : (
        <span className={`font-data tabular-nums text-right ${r.change_pct === null ? '' : priceDirClass(r.change_pct)}`}>
          {r.price != null ? `${r.price.toLocaleString('ko-KR')} (${formatPct(r.change_pct)})` : '—'}
        </span>
      )}
      <span className="font-data tabular-nums text-right text-fg-dim">{toEok(r.trade_value_won)}</span>
      <span className="flex items-center justify-end gap-2">
        <WatchlistHeartButton code={r.code} name={r.name} isMember={isMember(r.code)} variant="row" />
      </span>
    </DataTableRow>
  );
}

export function ResultTable({ rows, onActivate, sortMode = 'default', onSortChange, embedded = false, depthValues, depthSides }: Props) {
  // 훅은 표 전체에서 **한 번만** 부른다(useWatchlistMembership 계약: "ONCE per component,
  // not per row"). 행마다 부르던 시절엔 1,000행 = react-query 옵저버 1,000개였다.
  // 실측(재렌더): 500행 44 → 30 ms, 1,000행 65 → 59 ms.
  const { isMember } = useWatchlistMembership();

  // 가상화(2단계). 1단계(훅 끌어올리기)로 1,000행 65→59ms 였고, 남은 비용은 **행 자체의
  // 렌더·DOM** 이라 화면 밖 행을 안 그리는 것 말고는 줄일 방법이 없다.
  const shellRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const virtualize = rows.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => shellRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 8,
    // 헤더가 스크롤 요소 안에 있으므로 행 영역의 시작 오프셋을 알려줘야 한다.
    scrollMargin: rowsRef.current?.offsetTop ?? 0,
  });

  return (
    <DataTableShell
      scrollRef={shellRef}
      minWidth="640px"
      className={embedded ? 'flex-1 border-0 rounded-none bg-transparent' : ''}
    >
      <DataTableHeader columns={COLS}>
        {HEADERS.map((header) => (
          <SortHeader key={header.field} {...header} sortMode={sortMode} onSortChange={onSortChange} />
        ))}
        <span className="text-right text-xs font-semibold uppercase text-fg-dimmer">액션</span>
      </DataTableHeader>
      {rows.length === 0 ? (
        // sticky left-0: 빈 상태는 DataTableShell 의 min-width(640px) 안에 있어서,
        // 셸이 그보다 좁으면(반응형 바닥 부근) 가로 스크롤 밖으로 밀려 잘렸다.
        // 컬럼을 지킬 이유가 없는 콘텐츠이므로 스크롤포트 왼쪽에 붙여 항상 보이게 한다.
        <div className="flex-1 min-h-0">
          <EmptyState align="start" className="sticky left-0">조건에 맞는 종목이 없습니다.</EmptyState>
        </div>
      ) : virtualize ? (
        // 가상 경로 — 스크롤 요소는 **셸 자신**이다(`scrollRef`). 안쪽에 새 스크롤
        // 영역을 만들지 않으므로 헤더는 지금처럼 함께 스크롤된다(UX 불변).
        // `scrollMargin` 이 헤더 높이만큼의 오프셋을 보정한다.
        // **`flex-1 min-h-0` 을 쓰면 안 된다** — 스페이서의 명시 높이를 flex 가 덮어
        // 셸이 스크롤되지 않는다(실측: style 28000px 인데 실제 403px, scrollHeight ==
        // clientHeight, 14행 뒤로 도달 불가). `shrink-0` 로 높이를 지킨다.
        <div ref={rowsRef} data-testid="screener-result-rows" data-virtualized="true"
          className="shrink-0 relative"
          style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((vi) => (
            <ResultRow
              key={rows[vi.index].code}
              r={rows[vi.index]}
              isMember={isMember}
              onActivate={onActivate}
              depthValues={depthValues}
              depthSides={depthSides}
              measureRef={virtualizer.measureElement}
              style={{
                position: 'absolute', top: 0, left: 0, width: '100%',
                transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              }}
            />
          ))}
        </div>
      ) : (
        <div data-testid="screener-result-rows" data-virtualized="false" className="flex-1 min-h-0">
          {rows.map((r) => (
            <ResultRow key={r.code} r={r} isMember={isMember} onActivate={onActivate}
              depthValues={depthValues} depthSides={depthSides} />
          ))}
        </div>
      )}
    </DataTableShell>
  );
}

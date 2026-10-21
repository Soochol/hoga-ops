import './RankingColumns.css';
import { QuoteColumnProbe } from './QuoteColumnProbe';
import { useQuoteColumns } from './useQuoteColumns';
import { InlineState } from '../ui/DataSurface';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useJumpToLive, type JumpModifiers } from '../live/useJumpToLive';
import { useLivePageStore } from '../state/livePage';
import { useFrozenWhileDragging } from '../heatmap/useFrozenWhileDragging';
import { RailDragOverlay } from './RailDragOverlay';
import { useChartDropDrag, type ChartDropGhost } from './useChartDropDrag';
import {
  useLiveRankings,
  RANKINGS_PAGE_SIZE,
  RANKINGS_MAX_LIMIT,
  supportsRankingExpansion,
  rankingInitialLimit,
  type RankingDirection,
  type RankingKind,
  type RankingMarket,
  type RankingRow,
} from '../api/liveRankings';
import { QuoteRow } from './QuoteRow';
import { rankingMetricFor, type RankingMetric } from './rankingMetric';
import { QuoteRowGroupMenu } from './QuoteRowGroupMenu';
import {
  nextRankingSortMode,
  rankingSortDescription,
  rankingSortDirection,
  sortRankingRows,
  type RankingSortMode,
} from './rankingSort';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailDrawerSection, RailState } from '../ui/RailShell';
import { SegmentedControl } from '../ui/PageShell';
import { SortCycleButton } from '../ui/SortCycleButton';
import { useLiveVenueStore } from '../state/liveVenue';

/**
 * 순위 패널 (특징주) — 앱 전역 RightRail 형제(스크리너/관심종목과 동일 계열).
 * 키움 rkinfo 4종과 프로그램·기관·외국인 순매수 금액을 전환하고, 행 클릭은 activeCode 로 차트
 * 종목을 바꾼다(useJumpToLive). 거래대금·순매수 금액은 억원 단위 정수로
 * 종목명과 가격 사이 한 줄에 표시한다. 드래그로 특정 차트 창에 드롭하면 그 창만
 * 종목 교체(resolveDropOnChart, 스크리너와 동일 seam).
 *
 * 데이터는 10s 폴링(순매수 30s) — 장외엔 60s로 낮추고 "장 외" 라벨을 단다.
 * kind/market/direction 선택은 드로어 로컬 state(닫으면 초기화).
 */

const RANKING_ENTRY_TYPE = 'ranking-entry';
const RANKING_DRAG_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };

const KINDS: { key: RankingKind; label: string }[] = [
  { key: 'change', label: '등락률' },
  { key: 'surge', label: '거래량 급증' },
  { key: 'volume', label: '거래량' },
  { key: 'value', label: '거래대금' },
  { key: 'program', label: '프로그램' },
  { key: 'institution', label: '기관' },
  { key: 'foreign', label: '외국인' },
];

const NET_BUY_AMOUNT_FORMAT = new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: 0,
});
const TRADE_VALUE_FORMAT = new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: 0,
});
function formatTradeValue(won: number | null | undefined) {
  return won == null ? '—' : `${TRADE_VALUE_FORMAT.format(won / 100_000_000)}억`;
}
function TradeValue({ won }: { won: number | null | undefined }) {
  return <span className="ranking-trade-value flex-none text-right font-data tabular-nums text-xs text-fg-dim leading-tight"
    title={won == null ? undefined : `${won.toLocaleString('ko-KR')}원`}>
    {formatTradeValue(won)}
  </span>;
}

function formatNetBuyAmount(won: number | null | undefined) {
  if (won == null) return '—';
  const rounded = Math.round(Math.abs(won) / 100_000_000);
  return `${rounded === 0 ? '' : won > 0 ? '+' : '-'}${NET_BUY_AMOUNT_FORMAT.format(rounded)}억`;
}
function NetBuyAmount({ won, label }: { won: number | null | undefined; label: string }) {
  const amount = formatNetBuyAmount(won);
  return <span className="ranking-net-buy text-xs leading-tight font-data tabular-nums text-fg-dim" title={`${label} 순매수 ${amount}`}>{amount}</span>;
}

function netBuyAmount(row: RankingRow, kind: RankingKind): number | null | undefined {
  return kind === 'program' ? row.program_net_buy_won : row.investor_net_buy_won;
}

function RankingMetricValue({ metric }: { metric: RankingMetric }) {
  return <span className="ranking-metric flex-none text-right font-data tabular-nums text-xs text-fg-dim leading-tight"
    title={metric.title}>{metric.text}</span>;
}

const MARKETS: { key: RankingMarket; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'kospi', label: '코스피' },
  { key: 'kosdaq', label: '코스닥' },
];

function formatUpdatedAt(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 순위번호 슬롯 — 리스트 행과 드래그 고스트가 **함께** 쓴다.
 *
 *  반응형 열은 순위번호~이름 구간을 별도로 계산한다. 네 자리 순위의 실제 폭과
 *  0.125rem 간격을 보호하며 종목명 시작은 기본 2.5rem 으로 맞춘다. 나머지 숫자 열의
 *  간격이 변해도 이 구간은 유지한다(상세 식은 RankingColumns.css).
 *
 *  **왜 컴포넌트로 빼는가**: 두 곳에 손으로 옮겨 적으면 한쪽 폭만 바뀌었을 때 드래그
 *  중에만 어긋나고, 그 순간은 스크린샷으로 잡기 가장 어려운 상태다.
 *
 *  `rank` 가 optional 인 것은 스냅샷 타입(ChartDropGhost)이 스크리너와 공용이기 때문이고,
 *  값이 없어도 슬롯은 폭을 잡는다 — 정렬은 내용이 아니라 슬롯이 책임진다. */
function RankSlot({ rank }: { rank?: number }) {
  return (
    <span
      data-testid="ranking-rank"
      className="ranking-rank w-5 flex-none text-right font-data tabular-nums text-xs text-fg-dim"
    >
      {rank}
    </span>
  );
}

/** 순위 행.
 *
 *  **`memo` 인 이유와 그 조건**: 10초 폴링(useLiveRankings)이 드로어를 리렌더한다. 그때
 *  행까지 다시 그리면 드래그 중인 행이 흔들리므로, props 를 전부 스칼라 아니면 안정
 *  참조로 좁혔다 — 콜백은 `row` 를 인자로 받는 안정 참조이고 여기서 바인딩한다.
 *
 *  **transform 을 행에 걸지 않는다**: DragOverlay 고스트가 이동을 대신하므로 원본까지
 *  움직이면 같은 행이 두 개로 보인다. 원본은 제자리에서 들어올림 틴트(`dragging`)만
 *  남는다 — 관심종목처럼 빈 자리로 비우지 **않는다**. 이 드래그는 재정렬이 아니라 복사
 *  제스처라 드롭 후에도 행이 리스트에 남기 때문이다. */
const DraggableRankingRow = memo(function DraggableRankingRow({
  row,
  active,
  onActivate,
  onOpenMenu,
  kind,
  netBuyLabel,
  columnLayout,
}: {
  columnLayout: React.CSSProperties;
  row: RankingRow;
  active: boolean;
  onActivate: (row: RankingRow, e?: JumpModifiers) => void;
  onOpenMenu: (row: RankingRow, e: React.MouseEvent<HTMLLIElement>) => void;
  kind: RankingKind;
  netBuyLabel: string | undefined;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `${RANKING_ENTRY_TYPE}:${row.code}`,
    data: { type: RANKING_ENTRY_TYPE, code: row.code, name: row.name },
  });
  const handleActivate = useCallback((e?: JumpModifiers) => onActivate(row, e), [onActivate, row]);
  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLLIElement>) => onOpenMenu(row, e), [onOpenMenu, row]);
  const metric = rankingMetricFor(row, kind);
  return (
    <QuoteRow
      columnLayout={columnLayout}
      name={row.name} code={row.code}
      nameTooltip=""
      price={row.price}
      pct={row.change_pct}
      changeWon={null}
      active={active}
      ariaLabel={`${row.rank}위 ${row.name} ${row.code} 차트 열기`}
      testId={`ranking-row-${row.code}`}
      onClick={handleActivate}
      onContextMenu={handleContextMenu}
      leading={<RankSlot rank={row.rank} />}
      beforePrice={metric ? <RankingMetricValue metric={metric} /> : kind === 'value' ? <TradeValue won={row.trade_value_won} />
        : netBuyLabel ? <NetBuyAmount won={netBuyAmount(row, kind)} label={netBuyLabel} /> : undefined}
      sortableRef={setNodeRef}
      dragListeners={listeners}
      dragAttributes={attributes}
      dragging={isDragging}
    />
  );
});

/** 고스트에 그릴 행 — 리스트 행과 같은 QuoteRow 라 손에 든 것이 그대로 보인다.
 *
 *  **`leading` 을 같이 싣는 이유**는 두 가지다.
 *
 *  1. **정렬.** QuoteRow 의 좌측 여백은 `leading` 이 있으면 `pl-md`, 없으면(그리고
 *     `indented` 면) `pl-10` 이다 — 둘은 상호배타이고 `leading` 이 이긴다. 슬롯을 빼면
 *     고스트만 `pl-md` 로 떨어져 종목명이 리스트 행보다 1.75rem 왼쪽에서 시작한다.
 *  2. **복제.** 이 리포의 고스트 계약은 "네 리스트를 같은 x 로" 가 아니라 **"고스트는
 *     자기 리스트 행의 렌더를 그대로 복제한다"** 이다(관심종목 고스트는 무동작
 *     `trailingAction` 까지 싣는다). 순위 행의 좌측 슬롯은 여백이 아니라 순위번호이므로,
 *     `indented` 로 폭만 맞추면 손에 든 것이 집어 든 것과 달라지고 카드 안에 내용 없는
 *     거터가 남는다. */
function RankingDragGhost({ ghost, columnLayout }: { ghost: ChartDropGhost; columnLayout: React.CSSProperties }) {
  return (
    <QuoteRow
      columnLayout={columnLayout}
      name={ghost.name}
      nameTooltip=""
      price={ghost.price}
      pct={ghost.pct}
      changeWon={null}
      active={false}
      ariaLabel={ghost.name}
      testId="ranking-drag-ghost"
      leading={<RankSlot rank={ghost.rank} />}
      beforePrice={ghost.rankingMetric ? <RankingMetricValue metric={ghost.rankingMetric} />
        : ghost.tradeValueWon !== undefined ? <TradeValue won={ghost.tradeValueWon} />
        : ghost.netBuyLabel ? <NetBuyAmount won={ghost.netBuyWon} label={ghost.netBuyLabel} /> : undefined}
      onClick={() => {}}
    />
  );
}

export function RankingDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const openLive = useJumpToLive();

  const [kind, setKind] = useState<RankingKind>('change');
  const investor = kind === 'institution' || kind === 'foreign';
  const netBuyLabel = kind === 'program' ? '프로그램' : kind === 'institution' ? '기관' : kind === 'foreign' ? '외국인' : undefined;
  const [market, setMarket] = useState<RankingMarket>('all');
  const [direction, setDirection] = useState<RankingDirection>('up');
  const [excludeEtf, setExcludeEtf] = useState(false);
  const [sortMode, setSortMode] = useState<RankingSortMode>('default');
  const venue = useLiveVenueStore((s) => s.venue);
  const scope = `${kind}:${market}:${kind === 'change' ? direction : '-'}:${venue}`;
  const initialLimit = rankingInitialLimit(kind);
  const [range, setRange] = useState({ scope, limit: initialLimit });
  const limit = range.scope === scope ? range.limit : initialLimit;
  if (range.scope !== scope) setRange({ scope, limit: initialLimit });
  const expandable = supportsRankingExpansion(kind);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ testId: string; offset: number } | null>(null);

  // 행 우클릭 → 관심 그룹 편집 메뉴(스크리너 패널과 동일 관용구). raw 커서 좌표만
  // 담고 위치 클램프는 QuoteRowGroupMenu 가 실측 보정한다.
  const [rowMenu, setRowMenu] = useState<{ code: string; name: string; x: number; y: number } | null>(null);

  const { data, isPending, isError, error, isFetching, refetch } = useLiveRankings({ kind, market, direction, excludeEtf, limit });
  const expansion = data != null && limit > data.requestedLimit;

  const sensors = useSensors(useSensor(PointerSensor, RANKING_DRAG_SENSOR_OPTIONS));
  // 좌표 아래 창이 없을 때의 폴백(활성 그룹 교체). useJumpToLive 는 매 렌더 새 함수라
  // 그대로 쓰면 아래 훅의 콜백들이 매번 새로 생긴다 — ref 로 최신 것을 가리킨다.
  const openLiveRef = useRef(openLive);
  useEffect(() => { openLiveRef.current = openLive; });
  const fallbackPick = useCallback((code: string, name?: string) => {
    openLiveRef.current(code, name);
  }, []);
  const drag = useChartDropDrag(RANKING_ENTRY_TYPE, fallbackPick);

  // 드래그 중 목록 동결 — 여기엔 재시작될 sortable transition 이 없다(useDraggable).
  // 이게 막는 것은 **드래그 중인 행이 발밑에서 사라지는 것**이다: 10초 폴링이 착지하면
  // 순위가 통째로 갈리고, 잡고 있던 행이 언마운트되면 드래그가 그대로 끊긴다.
  const liveRows = useMemo(() => sortRankingRows(data?.rows ?? [], sortMode), [data?.rows, sortMode]);
  const rows = useFrozenWhileDragging(liveRows, drag.isDragging);
  const columnScope = useFrozenWhileDragging(data ? scope : null, drag.isDragging);
  const columnQuotes = useMemo(() => new Map(rows.map(row => [row.code, row])), [rows]);
  const columnCodes = useMemo(() => rows.map(row => row.code), [rows]);
  const extraFigures = useMemo(() => ({
    // Reserve four ranks from the start so expanding through 5000 never moves names.
    rank: ['8888', ...rows.map(row => String(row.rank))],
    detail: kind === 'value' ? rows.map(row => formatTradeValue(row.trade_value_won)) : netBuyLabel ? rows.flatMap(row => {
      const won = netBuyAmount(row, kind);
      return won == null ? ['—'] : [formatNetBuyAmount(Math.abs(won)), formatNetBuyAmount(-Math.abs(won))];
    }) : rows.map(row => rankingMetricFor(row, kind)?.text ?? '—'),
  }), [rows, kind, netBuyLabel]);
  const columns = useQuoteColumns(columnCodes, columnQuotes, scrollRef, columnScope, extraFigures);
  const columnLayout = useMemo(() => ({ ...columns.layout,
    '--quote-rank-gap': '0.125rem',
    '--quote-name-start': '2.5rem',
    // Use the left gutter for the four-digit figure; the name stays at 2.5rem.
    paddingLeft: 'max(0px, calc(var(--quote-name-start) - var(--quote-rank-width) - var(--quote-rank-gap)))',
    '--quote-name-min': 'calc(6 * var(--text-xs))',
    '--quote-extra-width': 'var(--quote-detail-width)', '--quote-column-gaps': 3,
  }) as React.CSSProperties, [columns.layout]);

  const captureAnchor = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const nodes = scroller.querySelectorAll<HTMLElement>('li[data-testid^="ranking-row-"]');
    // 순위 수가 커져도 매 스크롤마다 모든 행의 레이아웃을 읽지 않는다.
    let lo = 0;
    let hi = nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (nodes[mid].getBoundingClientRect().bottom <= top) lo = mid + 1;
      else hi = mid;
    }
    const first = nodes[lo];
    anchorRef.current = first ? { testId: first.dataset.testid!, offset: first.getBoundingClientRect().top - top } : null;
  }, []);
    // 펼친 목록이 갱신돼도 화면 위쪽 종목의 위치를 유지한다.
  const scrollScopeRef = useRef(scope);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (scrollScopeRef.current !== scope) {
      scroller.scrollTop = 0;
      anchorRef.current = null;
      scrollScopeRef.current = scope;
    } else if (anchorRef.current) {
      const anchor = anchorRef.current;
      const row = scroller.querySelector<HTMLElement>(`[data-testid="${anchor.testId}"]`);
      if (row) scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
    }
    captureAnchor();
  }, [rows, scope, captureAnchor]);
  useEffect(() => {
    const scroller = scrollRef.current;
    scroller?.addEventListener('scroll', captureAnchor, { passive: true });
    return () => scroller?.removeEventListener('scroll', captureAnchor);
  }, [captureAnchor]);

  const onDragStart = (ev: DragStartEvent) => {
    const code = String((ev.active.data.current as { code?: string } | undefined)?.code ?? '');
    const row = rows.find((r) => r.code === code);
    drag.onDragStart(
      ev,
      row ? {
        code: row.code, name: row.name, price: row.price, pct: row.change_pct, rank: row.rank,
        tradeValueWon: kind === 'value' ? row.trade_value_won ?? null : undefined,
        netBuyWon: netBuyLabel ? netBuyAmount(row, kind) ?? null : undefined,
        netBuyLabel,
        rankingMetric: rankingMetricFor(row, kind),
      } : null,
    );
  };

  const onActivateRow = useCallback((row: RankingRow, e?: JumpModifiers) => {
    openLiveRef.current(row.code, row.name, e);
  }, []);
  const onOpenRowMenu = useCallback((row: RankingRow, e: React.MouseEvent<HTMLLIElement>) => {
    e.preventDefault();
    setRowMenu({ code: row.code, name: row.name, x: e.clientX, y: e.clientY });
  }, []);

  const marketClosed = data != null && !data.marketOpen;

  return (
    <RailDrawer id="right-rail-ranking-panel" testId="ranking-panel" ariaLabel="순위">
      <QuoteColumnProbe probe={columns.probe} samples={columns.samples} />
      <RailDrawerHeader
        title="순위"
        actions={
          <span className="flex items-center gap-sm">
            {marketClosed && <span className="text-xs text-fg-dim">장 외</span>}
            <span className="font-data tabular-nums text-xs text-fg-dim">
              {formatUpdatedAt(data?.fetchedAtMs)}
            </span>
          </span>
        }
      />
      <RailDrawerSection className="flex flex-col gap-sm">
        <SegmentedControl aria-label="순위 종류" className="w-full !grid grid-cols-3">
          {KINDS.map((k) => {
            const on = kind === k.key;
            return (
              <button
                key={k.key}
                type="button"
                aria-pressed={on}
                onClick={() => { setKind(k.key); setSortMode('default'); }}
                className={`shrink-0 px-2 py-[3px] text-xs ${on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
              >
                {k.label}
              </button>
            );
          })}
        </SegmentedControl>
        <div className="flex items-center gap-sm">
          <select
            aria-label="시장"
            value={market}
            onChange={(e) => setMarket(e.target.value as RankingMarket)}
            className="rounded-lg border border-border bg-bg-input px-1.5 py-[3px] text-xs text-fg"
          >
            {MARKETS.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
          {/* ETF 제외 — 시장 필터와 직교하는 축이라 별도 토글. on 이면 백엔드가
              security_type(etf/etn) 종목을 응답에서 제거(exclude_etf). */}
          <button
            type="button"
            aria-pressed={excludeEtf}
            onClick={() => setExcludeEtf((v) => !v)}
            title="ETF·ETN 종목을 순위에서 제외"
            className={`rounded-lg border px-2 py-[3px] text-xs ${
              excludeEtf
                ? 'border-accent bg-tint-selection text-accent'
                : 'border-border bg-bg-input text-fg-dim hover:bg-bg-input-hover'
            }`}
          >
            ETF 제외
          </button>
          {kind === 'change' && (
            <SegmentedControl aria-label="정렬 방향" className="self-start">
              {(['up', 'down'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={direction === d}
                  onClick={() => setDirection(d)}
                  className={`px-2 py-[3px] text-xs ${direction === d ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
                >
                  {d === 'up' ? '↑상승' : '↓하락'}
                </button>
              ))}
            </SegmentedControl>
          )}
          {/* 현재 리스트를 등락률순으로 재정렬(클라이언트) — TR 지표순 리스트를 교차로
              등락률 이상치 관점에서 훑는다. 순위번호는 TR 고유 순위로 유지. */}
          <SortCycleButton
            variant="inline"
            className="ml-auto"
            direction={rankingSortDirection(sortMode)}
            label="등락률 정렬"
            description={rankingSortDescription(sortMode)}
            disabled={rows.length === 0}
            onClick={() => {
              anchorRef.current = null;
              if (scrollRef.current) scrollRef.current.scrollTop = 0;
              setSortMode(nextRankingSortMode(sortMode));
            }}
          />
        </div>
        {sortMode !== 'default' && <p className="mt-1 text-xs text-accent">등락률 {rankingSortDirection(sortMode) === 'asc' ? '↑ 낮은 순' : '↓ 높은 순'}</p>}
        {expandable && data && (
          <p className="text-xs text-fg-dim" aria-live="polite">
            상위 {data.queriedCount}위 조회
            {data.queriedCount !== data.rows.length && ` · ${data.rows.length}개 표시`}
            {sortMode !== 'default' && ' · 조회 범위 내 등락률순'}
          </p>
        )}
        {netBuyLabel && <p className="text-xs text-fg-dim">{investor ? '장중 추정 · ' : ''}순매수 금액 · 상위 {investor ? 100 : data?.requestedLimit ?? limit} · 30초 갱신</p>}
        {investor && (
          <p className="text-xs text-fg-dim">
            순위: 거래소 지정 미지원 · 시세: {data?.quoteVenue === 'UN' ? '통합' : data?.quoteVenue ?? '—'}
          </p>
        )}
      </RailDrawerSection>

      <RailDrawerBody testId="ranking-scroll" quoteNav scrollRef={scrollRef}>
        {/* 토글은 켰는데 심볼 마스터가 없어 거르지 못한 경우. 배지가 없으면 사용자에겐
            "ETF 제외가 안 먹는" 상태로만 보인다(원인 단서 0). 스크리너 경고와 같은 관용구. */}
        {data?.etfFilterUnavailable && (
          <InlineState tone="warn" className="mx-md mt-sm">
            종목 마스터를 불러오지 못해 ETF 를 거르지 못했습니다
          </InlineState>
        )}
        {isError && !data ? (
          <RailState tone="error">
            <div className="font-semibold" style={{ color: 'var(--error)' }}>조회 실패</div>
            {error instanceof Error && error.message && (
              <div className="text-fg-dim">{error.message}</div>
            )}
          </RailState>
        ) : isPending && !data ? (
          <RailState>불러오는 중…</RailState>
        ) : rows.length === 0 ? (
          <RailState>{marketClosed ? '장 외 — 표시할 순위가 없습니다' : '표시할 종목이 없습니다'}</RailState>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragMove={drag.onDragMove}
            onDragEnd={drag.onDragEnd}
            onDragCancel={drag.onDragCancel}
          >
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {rows.map((r) => (
                <DraggableRankingRow
                  columnLayout={columnLayout}
                  key={r.code}
                  row={r}
                  active={r.code === activeCode}
                  onActivate={onActivateRow}
                  onOpenMenu={onOpenRowMenu}
                  kind={kind}
                  netBuyLabel={netBuyLabel}
                />
              ))}
            </ul>
            {/* 커서를 따라오는 고스트 — 패널 밖(차트 창)까지 손에 든 것이 보인다. */}
            <RailDragOverlay droppedOnChart={drag.droppedOnChart}>
              {drag.ghost && <RankingDragGhost ghost={drag.ghost} columnLayout={columnLayout} />}
            </RailDragOverlay>
          </DndContext>
        )}
        {data && isError && (
          <div className={`px-md py-sm text-xs text-error ${expandable ? 'min-h-[3.5rem]' : ''}`} role="status">
            {isFetching ? '다시 조회 중…' : expansion ? '추가 조회 실패' : '갱신 실패 · 이전 목록을 표시합니다'}
            <button type="button" className="ml-2 underline" disabled={isFetching || drag.isDragging} onClick={() => { void refetch(); }}>
              {isFetching ? '불러오는 중…' : '다시 시도'}
            </button>
          </div>
        )}
        {expandable && data && !isError && (
          <div className="min-h-[3.5rem] px-md py-sm text-center text-xs text-fg-dim" aria-live="polite">
            {data.hasMore && data.requestedLimit < RANKINGS_MAX_LIMIT ? (
              <button
                type="button"
                className="w-full rounded-lg border border-border px-2 py-2 hover:bg-bg-input-hover disabled:cursor-default disabled:opacity-60"
                disabled={isFetching || drag.isDragging}
                onClick={() => {
                  captureAnchor();
                  setRange({ scope, limit: Math.min(data.requestedLimit + RANKINGS_PAGE_SIZE, RANKINGS_MAX_LIMIT) });
                }}
              >
                {expansion && isFetching ? '불러오는 중…' : `${data.requestedLimit + 1}~${Math.min(data.requestedLimit + RANKINGS_PAGE_SIZE, RANKINGS_MAX_LIMIT)}위 더 보기`}
              </button>
            ) : data.hasMore ? '상위 5,000위까지 조회했습니다' : '마지막 순위입니다'}
          </div>
        )}
      </RailDrawerBody>

      {rowMenu && (
        <QuoteRowGroupMenu
          code={rowMenu.code}
          name={rowMenu.name}
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
        />
      )}
    </RailDrawer>
  );
}

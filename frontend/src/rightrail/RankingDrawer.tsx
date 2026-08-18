import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type RankingDirection,
  type RankingKind,
  type RankingMarket,
  type RankingRow,
} from '../api/liveRankings';
import { QuoteRow } from './QuoteRow';
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

/**
 * 순위 패널 (특징주) — 앱 전역 RightRail 형제(스크리너/관심종목과 동일 계열).
 * 키움 rkinfo 4종을 SegmentedControl 로 전환하고, 행 클릭은 activeCode 로 차트
 * 종목을 바꾼다(useJumpToLive). 시안 A(세그먼트 리스트) 확정 — 기준값 열은 없다
 * (순서가 곧 기준값, 그릴링 결정 7). 드래그로 특정 차트 창에 드롭하면 그 창만
 * 종목 교체(resolveDropOnChart, 스크리너와 동일 seam).
 *
 * 데이터는 10s 폴링(useLiveRankings) — 장외엔 market_open=false 로 폴링이 멈추고
 * "장 외" 라벨을 단다. kind/market/direction 선택은 드로어 로컬 state(닫으면 초기화).
 */

const RANKING_ENTRY_TYPE = 'ranking-entry';
const RANKING_DRAG_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };

const KINDS: { key: RankingKind; label: string }[] = [
  { key: 'change', label: '등락률' },
  { key: 'surge', label: '량급증' },
  { key: 'volume', label: '거래량' },
  { key: 'value', label: '대금' },
];

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
 *  이 폭이 좌측 정렬 계약의 절반이다: `w-5`(1.25rem) + 행의 `gap-2`(0.5rem) = 1.75rem 이
 *  `pl-md`(0.75rem) 위에 얹혀 종목명 시작 x 를 2.5rem 으로 만든다 — 관심·히트맵이
 *  `QuoteRow indented`(pl-10)로 얻는 값과 같다(계약은 QuoteRow 의 prop 주석).
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
      className="w-5 flex-none text-right font-data tabular-nums text-xs text-fg-dim"
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
}: {
  row: RankingRow;
  active: boolean;
  onActivate: (row: RankingRow, e?: JumpModifiers) => void;
  onOpenMenu: (row: RankingRow, e: React.MouseEvent<HTMLLIElement>) => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `${RANKING_ENTRY_TYPE}:${row.code}`,
    data: { type: RANKING_ENTRY_TYPE, code: row.code, name: row.name },
  });
  const handleActivate = useCallback((e?: JumpModifiers) => onActivate(row, e), [onActivate, row]);
  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLLIElement>) => onOpenMenu(row, e), [onOpenMenu, row]);
  return (
    <QuoteRow
      name={row.name}
      price={row.price}
      pct={row.change_pct}
      changeWon={null}
      active={active}
      ariaLabel={`${row.rank}위 ${row.name} ${row.code} 차트 열기`}
      testId={`ranking-row-${row.code}`}
      onClick={handleActivate}
      onContextMenu={handleContextMenu}
      leading={<RankSlot rank={row.rank} />}
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
function RankingDragGhost({ ghost }: { ghost: ChartDropGhost }) {
  return (
    <QuoteRow
      name={ghost.name}
      price={ghost.price}
      pct={ghost.pct}
      changeWon={null}
      active={false}
      ariaLabel={ghost.name}
      testId="ranking-drag-ghost"
      leading={<RankSlot rank={ghost.rank} />}
      onClick={() => {}}
    />
  );
}

export function RankingDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const openLive = useJumpToLive();

  const [kind, setKind] = useState<RankingKind>('change');
  const [market, setMarket] = useState<RankingMarket>('all');
  const [direction, setDirection] = useState<RankingDirection>('up');
  const [excludeEtf, setExcludeEtf] = useState(false);
  const [sortMode, setSortMode] = useState<RankingSortMode>('default');

  // 행 우클릭 → 관심 그룹 편집 메뉴(스크리너 패널과 동일 관용구). raw 커서 좌표만
  // 담고 위치 클램프는 QuoteRowGroupMenu 가 실측 보정한다.
  const [rowMenu, setRowMenu] = useState<{ code: string; name: string; x: number; y: number } | null>(null);

  const { data, isPending, isError, error } = useLiveRankings({ kind, market, direction, excludeEtf });

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

  const onDragStart = (ev: DragStartEvent) => {
    const code = String((ev.active.data.current as { code?: string } | undefined)?.code ?? '');
    const row = rows.find((r) => r.code === code);
    drag.onDragStart(
      ev,
      row ? { code: row.code, name: row.name, price: row.price, pct: row.change_pct, rank: row.rank } : null,
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
        <SegmentedControl aria-label="순위 종류" className="self-start">
          {KINDS.map((k) => {
            const on = kind === k.key;
            return (
              <button
                key={k.key}
                type="button"
                aria-pressed={on}
                onClick={() => setKind(k.key)}
                className={`px-2 py-[3px] text-xs ${on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
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
            onClick={() => setSortMode(nextRankingSortMode(sortMode))}
          />
        </div>
      </RailDrawerSection>

      <RailDrawerBody testId="ranking-scroll" quoteNav>
        {/* 토글은 켰는데 심볼 마스터가 없어 거르지 못한 경우. 배지가 없으면 사용자에겐
            "ETF 제외가 안 먹는" 상태로만 보인다(원인 단서 0). 스크리너 경고와 같은 관용구. */}
        {data?.etfFilterUnavailable && (
          <div className="mx-md mt-sm rounded-lg border px-3 py-2 text-sm" style={{ color: 'var(--warn)' }}>
            종목 마스터를 불러오지 못해 ETF 를 거르지 못했습니다
          </div>
        )}
        {isError ? (
          <RailState tone="error">
            <div className="font-semibold" style={{ color: 'var(--error)' }}>조회 실패</div>
            {error instanceof Error && error.message && (
              <div className="text-fg-dim">{error.message}</div>
            )}
          </RailState>
        ) : isPending ? (
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
                  key={r.code}
                  row={r}
                  active={r.code === activeCode}
                  onActivate={onActivateRow}
                  onOpenMenu={onOpenRowMenu}
                />
              ))}
            </ul>
            {/* 커서를 따라오는 고스트 — 패널 밖(차트 창)까지 손에 든 것이 보인다. */}
            <RailDragOverlay droppedOnChart={drag.droppedOnChart}>
              {drag.ghost && <RankingDragGhost ghost={drag.ghost} />}
            </RailDragOverlay>
          </DndContext>
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

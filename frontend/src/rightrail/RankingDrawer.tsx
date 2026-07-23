import { useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useJumpToLive, type JumpModifiers } from '../live/useJumpToLive';
import { useEntryDragStore, isPointOnChart, dropPoint, resolveDropOnChart } from '../state/entryDrag';
import { useLivePageStore } from '../state/livePage';
import {
  useLiveRankings,
  type RankingDirection,
  type RankingKind,
  type RankingMarket,
  type RankingRow,
} from '../api/liveRankings';
import { QuoteRow } from './QuoteRow';
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

function DraggableRankingRow({
  row,
  active,
  onActivate,
}: {
  row: RankingRow;
  active: boolean;
  onActivate: (e?: JumpModifiers) => void;
}) {
  const { setNodeRef, listeners, attributes, transform, isDragging } = useDraggable({
    id: `${RANKING_ENTRY_TYPE}:${row.code}`,
    data: { type: RANKING_ENTRY_TYPE, code: row.code, name: row.name },
  });
  return (
    <QuoteRow
      name={row.name}
      price={row.price}
      pct={row.change_pct}
      changeWon={null}
      active={active}
      ariaLabel={`${row.rank}위 ${row.name} ${row.code} 차트 열기`}
      testId={`ranking-row-${row.code}`}
      onClick={onActivate}
      leading={
        <span className="w-5 flex-none text-right font-data tabular-nums text-xs text-fg-dimmer">
          {row.rank}
        </span>
      }
      sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition: undefined }}
      dragListeners={listeners}
      dragAttributes={attributes}
      dragging={isDragging}
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

  const { data, isPending, isError, error } = useLiveRankings({ kind, market, direction, excludeEtf });
  const rows = useMemo(() => sortRankingRows(data?.rows ?? [], sortMode), [data?.rows, sortMode]);

  const sensors = useSensors(useSensor(PointerSensor, RANKING_DRAG_SENSOR_OPTIONS));
  const startEntryDrag = useEntryDragStore((s) => s.startDrag);
  const setOverChart = useEntryDragStore((s) => s.setOverChart);
  const setDragPoint = useEntryDragStore((s) => s.setDragPoint);
  const endEntryDrag = useEntryDragStore((s) => s.endDrag);

  const onDragStart = (ev: DragStartEvent) => {
    if (ev.active.data.current?.type !== RANKING_ENTRY_TYPE) return;
    const d = ev.active.data.current as { code?: string };
    if (d.code) startEntryDrag(d.code);
  };
  const onDragMove = (ev: DragMoveEvent) => {
    if (ev.active.data.current?.type !== RANKING_ENTRY_TYPE) return;
    const point = dropPoint(ev);
    setOverChart(isPointOnChart(point));
    setDragPoint(point);
  };
  const onDragCancel = () => endEntryDrag();
  const onDragEnd = (ev: DragEndEvent) => {
    const wasRankingEntry = ev.active.data.current?.type === RANKING_ENTRY_TYPE;
    endEntryDrag();
    if (!wasRankingEntry || !isPointOnChart(dropPoint(ev))) return;
    const d = ev.active.data.current as { code?: string; name?: string } | undefined;
    if (!d?.code) return;
    // 창 위 드롭 = 그 창 그룹 종목 교체(정밀), 창 밖 = 활성 그룹 교체(openLive).
    if (resolveDropOnChart(dropPoint(ev), { code: d.code, name: d.name })) return;
    openLive(d.code, d.name);
  };

  const marketClosed = data != null && !data.marketOpen;

  return (
    <RailDrawer id="right-rail-ranking-panel" testId="ranking-panel" ariaLabel="순위">
      <RailDrawerHeader
        title="순위"
        actions={
          <span className="flex items-center gap-sm">
            {marketClosed && <span className="text-xs text-fg-dimmer">장 외</span>}
            <span className="font-data tabular-nums text-xs text-fg-dimmer">
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
            className="rounded-md border border-border bg-bg-input px-1.5 py-[3px] text-xs text-fg"
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
            className={`rounded-md border px-2 py-[3px] text-xs ${
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
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {rows.map((r) => (
                <DraggableRankingRow
                  key={r.code}
                  row={r}
                  active={r.code === activeCode}
                  onActivate={(e) => openLive(r.code, r.name, e)}
                />
              ))}
            </ul>
          </DndContext>
        )}
      </RailDrawerBody>
    </RailDrawer>
  );
}

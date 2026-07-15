import { useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useLiveBrokersAtCursor,
  useLiveOrderbookAtCursor,
} from '../api/useLiveCursor';
import type { RangeBundle } from '../api/types';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { realMsToYyyymmdd, subtractDaysKst } from '../live/liveDateTime';
import { useScreenerDailyCandles, prevCloseBeforeDate } from '../api/screenerDailyCandles';
import {
  buildCandleDateIndex,
  selectVolumeDistributionProfile,
  volumeDistributionClosePointsFromCandles,
} from '../live/continuousTradeVolumeDistribution';
import { useVolumeDistributionCutoffProfile } from '../live/useVolumeDistributionCutoffProfile';
import OrderbookTable from '../sidebar/OrderbookTable';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import ProgramTradeSummaryCard from '../sidebar/ProgramTradeSummaryCard';
import TotalQtyBar from '../sidebar/TotalQtyBar';
import {
  resolveBrokerCardProps,
  resolveCursorDetailScope,
  resolveOrderbookCardSnapshot,
} from '../sidebar/cursorDetailResolver';
import { VolumeDistributionCard } from '../sidebar/VolumeDistributionCard';
import { isMinuteTimeframe, type MinuteTimeframe } from '../state/livePage';
import { useLivePageStore } from '../state/livePage';
import type { StudyViewReference } from '../api/studyViews';
import { DataSection } from '../ui/DataSurface';
import { CardRestoreMenu } from '../ui/CardRestoreMenu';
import { DoubleChevronIcon } from '../ui/ChevronIcon';
import { PanelCard } from '../ui/PageShell';
import { type StudyCardKey, useStudyLayoutStore } from '../state/studyLayout';
import { reorderVisible } from '../state/keyOrder';

type Props = {
  save: StudyViewReference;
  bundle: RangeBundle;
};

/** 카드별 라벨·testid(대시 형태) 정적 메타. 렌더 순서·표시는 studyLayout store 소유. */
const STUDY_CARD_META: Record<StudyCardKey, { label: string; testId: string }> = {
  orderbook: { label: '10호가', testId: 'orderbook' },
  brokers: { label: '거래원', testId: 'brokers' },
  volumeDistribution: { label: '연속체결 매물대 분포', testId: 'volume-distribution' },
  program: { label: '프로그램', testId: 'program' },
};

function StudyGripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden fill="currentColor">
      <circle cx="2.5" cy="2.5" r="1.2" />
      <circle cx="7.5" cy="2.5" r="1.2" />
      <circle cx="2.5" cy="7" r="1.2" />
      <circle cx="7.5" cy="7" r="1.2" />
      <circle cx="2.5" cy="11.5" r="1.2" />
      <circle cx="7.5" cy="11.5" r="1.2" />
    </svg>
  );
}

export function StudyReferenceDetailPanel({ save, bundle }: Props) {
  const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionHoverCutoffEnabled = useLivePageStore((s) => s.volumeDistributionHoverCutoffEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const volumeDistributionColor = useLivePageStore((s) => s.volumeDistributionColor);
  const volumeDistributionMaxColor = useLivePageStore((s) => s.volumeDistributionMaxColor);
  const cursorScope = resolveCursorDetailScope({
    cursorMs,
    timeframe: save.timeframe,
  });
  const detailCursorMs = cursorScope.kind === 'minute-cursor' ? cursorScope.cursorMs : null;
  const minuteTimeframe: MinuteTimeframe | null = cursorScope.kind === 'minute-cursor'
    ? cursorScope.minuteTimeframe
    : isMinuteTimeframe(save.timeframe)
      ? save.timeframe
      : null;
  const spotOrderbook = useLiveOrderbookAtCursor({ code: save.code, timeframe: minuteTimeframe });
  const spotBrokers = useLiveBrokersAtCursor({ code: save.code, timeframe: minuteTimeframe });
  const orderbookSnapshot = resolveOrderbookCardSnapshot({
    scope: cursorScope,
    spotSnapshot: spotOrderbook?.snapshot,
    inactiveSnapshot: null,
    bufferFallbackSnapshot: null,
  });
  const brokerCard = resolveBrokerCardProps({
    scope: cursorScope,
    spotSeries: spotBrokers,
    inactiveSeries: null,
    inactiveCursorMs: null,
  });
  const volumeDistributionDate = detailCursorMs !== null
    ? realMsToYyyymmdd(detailCursorMs)
    : save.range.to_date;
  // 10호가 가격색 기준 = 리플레이 날짜(volumeDistributionDate)의 전일 종가 = 그 직전 거래일의
  // 일봉 close(라이브의 quote.baseline_price 와 같은 의미, 과거일 판). 커서 이동 시
  // volumeDistributionDate 가 그 위치 날짜로 바뀌므로 색 기준도 따라간다. 호가가 실제로 있을
  // 때만(minute-cursor 스코프) 조회 — 15일 창(주말·공휴일 커버). screener-daily-candles 는
  // 이미 D/W/M study 가 쓰는 KRX 확정 일봉 소스라 신규 API 표면 없음.
  const baselineFrom = subtractDaysKst(volumeDistributionDate, 15);
  const prevCloseQuery = useScreenerDailyCandles(
    orderbookSnapshot ? save.code : null,
    baselineFrom,
    volumeDistributionDate,
  );
  const baselinePrice = useMemo(
    () => prevCloseBeforeDate(prevCloseQuery.data?.candles ?? [], volumeDistributionDate),
    [prevCloseQuery.data, volumeDistributionDate],
  );
  const candleDateIndex = useMemo(
    () => buildCandleDateIndex(bundle.candles),
    [bundle.candles],
  );
  const volumeDistributionCandles = useMemo(
    () => candleDateIndex.get(volumeDistributionDate) ?? [],
    [candleDateIndex, volumeDistributionDate],
  );
  const volumeDistribution = useMemo(
    () => selectVolumeDistributionProfile({
      enabled: volumeDistributionEnabled,
      date: volumeDistributionDate,
      todayKst: null,
      rangeCount: volumeDistributionRangeCount,
      persistedProfiles: bundle.volume_distributions ?? [],
      recomputedToday: null,
      liveTrades: [],
    }),
    [
      bundle.volume_distributions,
      volumeDistributionDate,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    ],
  );
  const cardOrder = useStudyLayoutStore((s) => s.cardOrder);
  const cardHidden = useStudyLayoutStore((s) => s.cardHidden);
  const setCardOrder = useStudyLayoutStore((s) => s.setCardOrder);
  const setCardHidden = useStudyLayoutStore((s) => s.setCardHidden);
  const setDetailPanelCollapsed = useStudyLayoutStore((s) => s.setDetailPanelCollapsed);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // 키보드 재배열(a11y): 드래그 핸들 포커스 → Space 로 집기, ↑/↓ 로 이동, Space 로 놓기.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [drag, setDrag] = useState<{ active: StudyCardKey; over: StudyCardKey | null } | null>(null);
  const cutoffVolumeDistribution = useVolumeDistributionCutoffProfile({
    enabled:
      volumeDistributionEnabled
      && volumeDistributionHoverCutoffEnabled
      && detailCursorMs !== null,
    code: save.code,
    timeframe: minuteTimeframe,
    date: volumeDistributionDate,
    cursorMs: detailCursorMs,
    todayKst: null,
    rangeCount: volumeDistributionRangeCount,
    finalProfile: volumeDistribution,
    priceRange: null,
    liveTrades: [],
    candles: volumeDistributionCandles,
    segment: bundle.segments.find((segment) => segment.date === volumeDistributionDate) ?? null,
  });
  const volumeClosePoints = useMemo(
    () => volumeDistributionClosePointsFromCandles(volumeDistributionCandles),
    [volumeDistributionCandles],
  );

  const contentByKey: Record<StudyCardKey, ReactNode> = {
    orderbook: (
      <>
        <OrderbookTable snapshot={orderbookSnapshot} baselinePrice={baselinePrice} />
        <TotalQtyBar snapshot={orderbookSnapshot} maskRatio={false} />
      </>
    ),
    brokers: <BrokerTrajectoryTable series={brokerCard.series} cursorMs={brokerCard.cursorMs} />,
    volumeDistribution: (
      <VolumeDistributionCard
        profile={cutoffVolumeDistribution}
        cursorMs={detailCursorMs}
        closePoints={volumeClosePoints}
        color={volumeDistributionColor}
        maxColor={volumeDistributionMaxColor}
      />
    ),
    program: <ProgramTradeSummaryCard series={bundle.program_trade} cursorMs={detailCursorMs} />,
  };

  const visible = cardOrder.filter((key) => !cardHidden[key]);
  const hiddenCards = cardOrder
    .filter((key) => cardHidden[key])
    .map((key) => ({ key, label: STUDY_CARD_META[key].label }));

  const insertionEdgeFor = (key: StudyCardKey): 'top' | 'bottom' | null => {
    if (!drag || !drag.over || drag.active === key || drag.over !== key) return null;
    const ai = visible.indexOf(drag.active);
    const oi = visible.indexOf(key);
    if (ai < 0 || oi < 0) return null;
    return ai < oi ? 'bottom' : 'top';
  };

  const handleDragStart = (event: DragStartEvent) => {
    setDrag({ active: event.active.id as StudyCardKey, over: event.active.id as StudyCardKey });
  };
  const handleDragOver = (event: DragOverEvent) => {
    setDrag((prev) => (prev ? { active: prev.active, over: (event.over?.id ?? null) as StudyCardKey | null } : prev));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setDrag(null);
    const activeKey = event.active.id as StudyCardKey;
    const overKey = event.over?.id as StudyCardKey | undefined;
    if (!overKey || activeKey === overKey) return;
    const from = visible.indexOf(activeKey);
    const to = visible.indexOf(overKey);
    if (from < 0 || to < 0) return;
    const hiddenSet = new Set(cardOrder.filter((key) => cardHidden[key]));
    setCardOrder(reorderVisible(cardOrder, hiddenSet, from, to));
  };
  const handleDragCancel = () => setDrag(null);

  return (
    <div className="flex min-h-full flex-col">
      <div
        data-testid="study-detail-controls"
        className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-bg-subtle/40 px-2 py-1"
      >
        <button
          type="button"
          data-testid="study-detail-panel-collapse"
          aria-label="상세 패널 접기"
          onClick={() => setDetailPanelCollapsed(true)}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-dimmer hover:bg-bg-input-hover hover:text-fg"
        >
          <DoubleChevronIcon direction="right" />
        </button>
        <CardRestoreMenu
          hidden={hiddenCards}
          onRestore={(key) => setCardHidden(key as StudyCardKey, false)}
          testId="study-detail-restore"
        />
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={visible} strategy={verticalListSortingStrategy}>
          <div
            data-testid="study-reference-detail-cards"
            className="flex min-h-full flex-1 flex-col gap-2 bg-bg-subtle/40 p-2"
          >
            {visible.map((key) => (
              <SortableStudyCard
                key={key}
                cardKey={key}
                content={contentByKey[key]}
                insertionEdge={insertionEdgeFor(key)}
                onHide={() => setCardHidden(key, true)}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {drag ? <DragOverlayStudyCard cardKey={drag.active} content={contentByKey[drag.active]} /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function SortableStudyCard({
  cardKey,
  content,
  insertionEdge,
  onHide,
}: {
  cardKey: StudyCardKey;
  content: ReactNode;
  insertionEdge: 'top' | 'bottom' | null;
  onHide: () => void;
}) {
  const meta = STUDY_CARD_META[cardKey];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cardKey,
  });

  // PanelCard 는 ref 를 forward 하지 않으므로 sortable 노드는 래퍼 div — 카드 크롬·testid 는
  // PanelCard 에 두고 래퍼는 dnd transform·삽입선 앵커만 담는다. relative = 삽입선 앵커.
  return (
    <div
      ref={setNodeRef}
      className="relative"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // 드래그 중인 카드는 자리만 유지(투명) — 실제 카드는 DragOverlay 클론이 그린다.
        ...(isDragging ? { opacity: 0 } : {}),
      }}
    >
      {insertionEdge && (
        <span
          aria-hidden
          data-testid={`study-detail-drop-${meta.testId}`}
          className="pointer-events-none absolute inset-x-1 z-20 h-0.5 rounded-full bg-accent"
          style={{ [insertionEdge]: -5 }}
        />
      )}
    <PanelCard data-testid={`study-detail-card-${meta.testId}`} className="flex flex-col">
      <DataSection
        title={meta.label}
        headerLeading={
          <button
            type="button"
            data-testid={`study-detail-drag-${meta.testId}`}
            aria-label={`${meta.label} 카드 이동`}
            className="flex h-6 w-5 cursor-grab items-center justify-center text-fg-dimmer hover:text-fg active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <StudyGripIcon />
          </button>
        }
        headerTrailing={
          <button
            type="button"
            data-testid={`study-detail-hide-${meta.testId}`}
            aria-label={`${meta.label} 카드 숨기기`}
            onClick={onHide}
            className="flex h-6 w-5 items-center justify-center text-fg-dimmer hover:text-fg"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        }
        className="flex flex-1 flex-col border-t-0"
        contentClassName="flex-1"
      >
        <div data-testid={`study-detail-content-${meta.testId}`} className="flex-1">
          {content}
        </div>
      </DataSection>
    </PanelCard>
    </div>
  );
}

/** DragOverlay 안 고정 크기 클론(비대화형) — 드래그 내내 크기 일정, 스냅백 없음.
 *  testid 는 붙이지 않는다(원본과 충돌 방지). */
function DragOverlayStudyCard({ cardKey, content }: { cardKey: StudyCardKey; content: ReactNode }) {
  const meta = STUDY_CARD_META[cardKey];
  return (
    <PanelCard className="flex flex-col shadow-modal">
      <DataSection
        title={meta.label}
        headerLeading={
          <span className="flex h-6 w-5 cursor-grabbing items-center justify-center text-fg-dim">
            <StudyGripIcon />
          </span>
        }
        headerTrailing={
          <span className="flex h-6 w-5 items-center justify-center text-fg-dimmer">
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </span>
        }
        className="flex flex-1 flex-col border-t-0"
        contentClassName="flex-1"
      >
        <div className="flex-1">{content}</div>
      </DataSection>
    </PanelCard>
  );
}

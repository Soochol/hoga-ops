import { Fragment, type ReactNode, useEffect, useRef } from 'react';
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  type LiveCardKey,
  LIVE_CARD_MIN_HEIGHT_PX,
  resizeAdjacentWeights,
  useLiveLayoutStore,
} from '../state/liveLayout';
import { reorderVisible } from '../state/keyOrder';
import { DataSection } from '../ui/DataSurface';
import { CardRestoreMenu } from '../ui/CardRestoreMenu';
import { DoubleChevronIcon } from '../ui/ChevronIcon';

type Props = {
  orderbook: ReactNode;
  volumeDistribution?: ReactNode;
  program: ReactNode;
  brokers: ReactNode;
  investor: ReactNode;
  /** 접힌 카드 헤더의 "데이터 없음" 점 표시용. 키 부재/false = 점 없음. */
  emptyByCard?: Partial<Record<LiveCardKey, boolean>>;
};

type CardMeta = { label: string; testId: string; contentTestId: string };

/** 카드별 정적 메타(라벨·testid). 렌더 순서는 store 의 `rightCardOrder` 가 소유하고,
 *  표시 여부는 `rightCardHidden` 이 소유한다(ADR-0114). */
const CARD_META: Record<LiveCardKey, CardMeta> = {
  orderbook: { label: '10호가', testId: 'live-detail-card-orderbook', contentTestId: 'card-orderbook' },
  brokers: { label: '거래원', testId: 'live-detail-card-brokers', contentTestId: 'card-brokers' },
  volumeDistribution: {
    label: '매물대',
    testId: 'live-detail-card-volumeDistribution',
    contentTestId: 'card-volume-distribution',
  },
  program: { label: '프로그램 순매수', testId: 'live-detail-card-program', contentTestId: 'card-program' },
  investor: { label: '잠정투자자', testId: 'live-detail-card-investor', contentTestId: 'card-investor' },
};

const RESIZER_HEIGHT_PX = 8;
const WEIGHT_TO_MIN_HEIGHT_PX = 6;

type ResizerPair = { upper: LiveCardKey; lower: LiveCardKey; label: string };

function GripIcon() {
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

/** 카드 헤더 우측에 놓이는 드래그 핸들 + 숨김 버튼. 핸들의 listeners/attributes 는
 *  SortableCard 가 주입한다(핸들만 잡아 드래그, 헤더 클릭은 접기 그대로). */
function CardHeaderControls({
  cardKey,
  label,
  dragProps,
}: {
  cardKey: LiveCardKey;
  label: string;
  dragProps: React.HTMLAttributes<HTMLButtonElement>;
}) {
  const setCardHidden = useLiveLayoutStore((state) => state.setCardHidden);
  return (
    <>
      <button
        type="button"
        data-testid={`live-detail-drag-${cardKey}`}
        aria-label={`${label} 카드 이동`}
        className="flex h-6 w-5 cursor-grab items-center justify-center text-fg-dimmer hover:text-fg active:cursor-grabbing"
        {...dragProps}
      >
        <GripIcon />
      </button>
      <button
        type="button"
        data-testid={`live-detail-hide-${cardKey}`}
        aria-label={`${label} 카드 숨기기`}
        onClick={() => setCardHidden(cardKey, true)}
        className="flex h-6 w-5 items-center justify-center text-fg-dimmer hover:text-fg"
      >
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </>
  );
}

function SortableCard({
  cardKey,
  meta,
  content,
  collapsed,
  minHeight,
  emptyDot,
  onToggleCollapse,
}: {
  cardKey: LiveCardKey;
  meta: CardMeta;
  content: ReactNode;
  collapsed: boolean;
  minHeight: number | undefined;
  emptyDot: boolean;
  onToggleCollapse: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cardKey,
  });

  return (
    <div
      ref={setNodeRef}
      data-testid={meta.testId}
      data-card={cardKey}
      // 이음매 겹침 제거(2026-07-15): 카드 border-t 를 걷어내고 8px 리사이저 gap 안의
      // bg-border 선 하나만 이음매로 남긴다("분리는 톤+간격").
      className="flex flex-col"
      style={{
        minHeight,
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { opacity: 0.65, position: 'relative', zIndex: 10 } : {}),
      }}
    >
      <DataSection
        title={meta.label}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        showEmptyDot={emptyDot}
        toggleTestId={`live-detail-toggle-${cardKey}`}
        headerTrailing={
          <CardHeaderControls
            cardKey={cardKey}
            label={meta.label}
            dragProps={{ ...attributes, ...listeners }}
          />
        }
        className="flex flex-1 flex-col border-t-0"
        contentClassName="flex-1"
      >
        <div data-testid={`live-detail-content-${cardKey}`} className="flex-1">
          <div data-testid={meta.contentTestId}>{content}</div>
        </div>
      </DataSection>
    </div>
  );
}

export function LiveDetailPanel({
  orderbook,
  volumeDistribution,
  program,
  brokers,
  investor,
  emptyByCard,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  const weights = useLiveLayoutStore((state) => state.rightCardWeights);
  const setWeights = useLiveLayoutStore((state) => state.setRightCardWeights);
  const order = useLiveLayoutStore((state) => state.rightCardOrder);
  const hidden = useLiveLayoutStore((state) => state.rightCardHidden);
  const setRightCardOrder = useLiveLayoutStore((state) => state.setRightCardOrder);
  const setCardHidden = useLiveLayoutStore((state) => state.setCardHidden);
  const collapsed = useLiveLayoutStore((state) => state.rightCardCollapsed);
  const toggleCardCollapsed = useLiveLayoutStore((state) => state.toggleCardCollapsed);
  const setAllCardsCollapsed = useLiveLayoutStore((state) => state.setAllCardsCollapsed);
  const setDetailPanelCollapsed = useLiveLayoutStore((state) => state.setDetailPanelCollapsed);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => () => {
    activeResizeCleanupRef.current?.();
    activeResizeCleanupRef.current = null;
  }, []);

  const contentByKey: Record<LiveCardKey, ReactNode> = {
    orderbook,
    brokers,
    volumeDistribution: volumeDistribution ?? null,
    program,
    investor,
  };

  const visible = order.filter((key) => !hidden[key]);
  const hiddenCards = order
    .filter((key) => hidden[key])
    .map((key) => ({ key, label: CARD_META[key].label }));

  // 리사이저는 보이는 카드의 인접쌍에서 파생 — 기본 순서·숨김 없음이면 오늘과
  // 동일한 4개 separator(라벨·testid 동일)를 재생산한다.
  const pairs: ResizerPair[] = visible.slice(0, -1).map((upper, index) => {
    const lower = visible[index + 1];
    return { upper, lower, label: `${CARD_META[upper].label} / ${CARD_META[lower].label} 크기 조절` };
  });

  const beginResize =
    (upper: LiveCardKey, lower: LiveCardKey) => (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      const startY = event.clientY;
      const startWeights = useLiveLayoutStore.getState().rightCardWeights;
      const panelHeight = panelRef.current?.clientHeight ?? 0;
      const totalWeight = Object.values(startWeights).reduce((sum, weight) => sum + weight, 0);
      const pairWeight = startWeights[upper] + startWeights[lower];
      const contentHeight = Math.max(0, panelHeight - pairs.length * RESIZER_HEIGHT_PX);
      const pairHeight =
        totalWeight > 0 && pairWeight > 0 ? (contentHeight * pairWeight) / totalWeight : 0;

      target.setPointerCapture(event.pointerId);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextWeights = resizeAdjacentWeights(
          startWeights,
          upper,
          lower,
          moveEvent.clientY - startY,
          pairHeight,
        );
        useLiveLayoutStore.setState({ rightCardWeights: nextWeights });
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerCancel);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        activeResizeCleanupRef.current = null;
      };

      const finishResize = (pointerId: number) => {
        if (target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
        cleanup();
        setWeights(useLiveLayoutStore.getState().rightCardWeights);
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        finishResize(upEvent.pointerId);
      };

      const handlePointerCancel = (cancelEvent: PointerEvent) => {
        finishResize(cancelEvent.pointerId);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerCancel);
      activeResizeCleanupRef.current = cleanup;
    };

  const handleDragEnd = (event: DragEndEvent) => {
    const activeKey = event.active.id as LiveCardKey;
    const overKey = event.over?.id as LiveCardKey | undefined;
    if (!overKey || activeKey === overKey) return;
    const from = visible.indexOf(activeKey);
    const to = visible.indexOf(overKey);
    if (from < 0 || to < 0) return;
    const hiddenSet = new Set(order.filter((key) => hidden[key]));
    setRightCardOrder(reorderVisible(order, hiddenSet, from, to));
  };

  const allCollapsed = visible.length > 0 && visible.every((key) => collapsed[key]);

  return (
    <div className="flex min-h-full flex-col bg-bg-card">
      <div
        data-testid="live-detail-controls"
        className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-card px-2 py-1"
      >
        <button
          type="button"
          data-testid="live-detail-panel-collapse"
          aria-label="상세 패널 접기"
          onClick={() => setDetailPanelCollapsed(true)}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-dimmer hover:bg-bg-input-hover hover:text-fg"
        >
          <DoubleChevronIcon direction="right" />
        </button>
        <div className="flex items-center gap-1">
          <CardRestoreMenu
            hidden={hiddenCards}
            onRestore={(key) => setCardHidden(key as LiveCardKey, false)}
            testId="live-detail-restore"
          />
          <button
            type="button"
            data-testid="live-detail-collapse-all"
            onClick={() => setAllCardsCollapsed(!allCollapsed)}
            className="rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-fg-dimmer hover:bg-bg-input-hover hover:text-fg"
          >
            {allCollapsed ? '모두 펴기' : '모두 접기'}
          </button>
        </div>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visible} strategy={verticalListSortingStrategy}>
          <aside
            ref={panelRef}
            data-testid="live-detail-panel"
            className="grid min-h-full flex-1 bg-bg-card"
            style={{
              gridTemplateRows: visible
                .map((key) => (collapsed[key] ? 'min-content' : 'auto'))
                .join(' 8px '),
            }}
          >
            {visible.map((key, index) => {
              const isCollapsed = Boolean(collapsed[key]);
              const resizer = index < pairs.length ? pairs[index] : null;
              // 이웃 카드가 하나라도 접혀 있으면 리사이저를 inert 로 — DOM 에는 유지하되
              // 드래그를 비활성해 8px 행 정렬과 separator 개수를 보존한다.
              const resizerInert = resizer
                ? Boolean(collapsed[resizer.upper]) || Boolean(collapsed[resizer.lower])
                : false;
              return (
                <Fragment key={key}>
                  <SortableCard
                    cardKey={key}
                    meta={CARD_META[key]}
                    content={contentByKey[key]}
                    collapsed={isCollapsed}
                    minHeight={
                      isCollapsed
                        ? undefined
                        : Math.max(
                            LIVE_CARD_MIN_HEIGHT_PX[key],
                            Math.round(weights[key] * WEIGHT_TO_MIN_HEIGHT_PX),
                          )
                    }
                    emptyDot={Boolean(emptyByCard?.[key])}
                    onToggleCollapse={() => toggleCardCollapsed(key)}
                  />
                  {resizer ? (
                    <div
                      role="separator"
                      aria-label={resizer.label}
                      aria-orientation="horizontal"
                      aria-disabled={resizerInert || undefined}
                      data-inert={resizerInert || undefined}
                      data-testid={`live-detail-resizer-${resizer.upper}-${resizer.lower}`}
                      className={`grid min-h-[8px] place-items-center ${resizerInert ? 'cursor-default' : 'cursor-row-resize'}`}
                      style={{ touchAction: 'none' }}
                      onPointerDown={resizerInert ? undefined : beginResize(resizer.upper, resizer.lower)}
                    >
                      <div aria-hidden className={`h-px w-full bg-border ${resizerInert ? 'opacity-40' : ''}`.trim()} />
                    </div>
                  ) : null}
                </Fragment>
              );
            })}
          </aside>
        </SortableContext>
      </DndContext>
    </div>
  );
}

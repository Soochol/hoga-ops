import { type ReactNode, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type LiveCardKey, useLiveLayoutStore } from '../state/liveLayout';
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

const CARD_SHELL = 'relative flex flex-col rounded-lg border border-border bg-bg-card';

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

function CloseGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}

function GripButton({
  cardKey,
  label,
  dragProps,
}: {
  cardKey: LiveCardKey;
  label: string;
  dragProps?: React.HTMLAttributes<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      data-testid={`live-detail-drag-${cardKey}`}
      aria-label={`${label} 카드 이동`}
      className="flex h-6 w-5 cursor-grab items-center justify-center text-fg-dimmer hover:text-fg active:cursor-grabbing"
      {...dragProps}
    >
      <GripIcon />
    </button>
  );
}

/** 정렬 가능한 카드. 드래그 중에는 원래 슬롯을 opacity 0 으로 비워 자리만 유지하고(형제
 *  reflow 계산용), 실제 시각은 DragOverlay 의 고정 크기 클론이 담당한다 — 가변 높이
 *  카드의 드래그 중 크기 변동(reflow jank)을 없앤다. */
function SortableCard({
  cardKey,
  meta,
  content,
  insertionEdge,
}: {
  cardKey: LiveCardKey;
  meta: CardMeta;
  content: ReactNode;
  /** 드래그 중 이 카드가 드롭 타겟일 때 삽입선을 그릴 가장자리. null = 표시 안 함. */
  insertionEdge: 'top' | 'bottom' | null;
}) {
  const setCardHidden = useLiveLayoutStore((state) => state.setCardHidden);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cardKey,
  });

  return (
    <div
      ref={setNodeRef}
      data-testid={meta.testId}
      data-card={cardKey}
      className={`${CARD_SHELL} shadow-panel`}
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
          data-testid={`live-detail-drop-${cardKey}`}
          className="pointer-events-none absolute inset-x-1 z-20 h-0.5 rounded-full bg-accent"
          style={{ [insertionEdge]: -5 }}
        />
      )}
      <DataSection
        title={meta.label}
        headerLeading={<GripButton cardKey={cardKey} label={meta.label} dragProps={{ ...attributes, ...listeners }} />}
        headerTrailing={
          <button
            type="button"
            data-testid={`live-detail-hide-${cardKey}`}
            aria-label={`${meta.label} 카드 숨기기`}
            onClick={() => setCardHidden(cardKey, true)}
            className="flex h-6 w-5 items-center justify-center text-fg-dimmer hover:text-fg"
          >
            <CloseGlyph />
          </button>
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

/** DragOverlay 안에서 커서를 따라 떠다니는 고정 크기 클론(비대화형). 크기는 DragOverlay
 *  가 원본 카드 rect 로 자동 지정하므로 드래그 내내 일정하다. testid 는 붙이지 않는다
 *  (원본과 충돌 방지). */
function DragOverlayCard({ meta, content }: { meta: CardMeta; content: ReactNode }) {
  return (
    <div className={`${CARD_SHELL} shadow-modal`}>
      <DataSection
        title={meta.label}
        headerLeading={
          <span className="flex h-6 w-5 cursor-grabbing items-center justify-center text-fg-dim">
            <GripIcon />
          </span>
        }
        headerTrailing={
          <span className="flex h-6 w-5 items-center justify-center text-fg-dimmer">
            <CloseGlyph />
          </span>
        }
        className="flex flex-1 flex-col border-t-0"
        contentClassName="flex-1"
      >
        <div className="flex-1">{content}</div>
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
}: Props) {
  const order = useLiveLayoutStore((state) => state.rightCardOrder);
  const hidden = useLiveLayoutStore((state) => state.rightCardHidden);
  const setRightCardOrder = useLiveLayoutStore((state) => state.setRightCardOrder);
  const setCardHidden = useLiveLayoutStore((state) => state.setCardHidden);
  const setDetailPanelCollapsed = useLiveLayoutStore((state) => state.setDetailPanelCollapsed);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // 드래그 상태 — 삽입선 위치 + DragOverlay 클론 대상. { active, over } 키.
  const [drag, setDrag] = useState<{ active: LiveCardKey; over: LiveCardKey | null } | null>(null);

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

  // 드롭 타겟 카드의 어느 가장자리에 삽입선을 그릴지 — active 가 over 보다 위면 아래,
  // 아래면 위(놓을 방향). active 카드 자신엔 표시하지 않는다.
  const insertionEdgeFor = (key: LiveCardKey): 'top' | 'bottom' | null => {
    if (!drag || !drag.over || drag.active === key || drag.over !== key) return null;
    const ai = visible.indexOf(drag.active);
    const oi = visible.indexOf(key);
    if (ai < 0 || oi < 0) return null;
    return ai < oi ? 'bottom' : 'top';
  };

  const handleDragStart = (event: DragStartEvent) => {
    setDrag({ active: event.active.id as LiveCardKey, over: event.active.id as LiveCardKey });
  };
  const handleDragOver = (event: DragOverEvent) => {
    setDrag((prev) => (prev ? { active: prev.active, over: (event.over?.id ?? null) as LiveCardKey | null } : prev));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setDrag(null);
    const activeKey = event.active.id as LiveCardKey;
    const overKey = event.over?.id as LiveCardKey | undefined;
    if (!overKey || activeKey === overKey) return;
    const from = visible.indexOf(activeKey);
    const to = visible.indexOf(overKey);
    if (from < 0 || to < 0) return;
    const hiddenSet = new Set(order.filter((key) => hidden[key]));
    setRightCardOrder(reorderVisible(order, hiddenSet, from, to));
  };
  const handleDragCancel = () => setDrag(null);

  return (
    <div className="flex min-h-full flex-col bg-bg-subtle">
      <div
        data-testid="live-detail-controls"
        className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-subtle px-2 py-1"
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
        <CardRestoreMenu
          hidden={hiddenCards}
          onRestore={(key) => setCardHidden(key as LiveCardKey, false)}
          testId="live-detail-restore"
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
          <aside
            data-testid="live-detail-panel"
            className="flex min-h-full flex-1 flex-col gap-2 bg-bg-subtle p-2"
          >
            {visible.map((key) => (
              <SortableCard
                key={key}
                cardKey={key}
                meta={CARD_META[key]}
                content={contentByKey[key]}
                insertionEdge={insertionEdgeFor(key)}
              />
            ))}
          </aside>
        </SortableContext>
        <DragOverlay>
          {drag ? <DragOverlayCard meta={CARD_META[drag.active]} content={contentByKey[drag.active]} /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

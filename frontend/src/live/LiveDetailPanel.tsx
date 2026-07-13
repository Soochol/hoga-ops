import { type ReactNode, useEffect, useRef } from 'react';
import {
  type LiveCardKey,
  LIVE_CARD_MIN_HEIGHT_PX,
  resizeAdjacentWeights,
  useLiveLayoutStore,
} from '../state/liveLayout';
import { DataSection } from '../ui/DataSurface';
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

type CardDef = {
  key: LiveCardKey;
  label: string;
  testId: string;
  contentTestId: string;
  content: ReactNode;
};

const RESIZER_PAIRS: Array<{ upper: LiveCardKey; lower: LiveCardKey; label: string }> = [
  { upper: 'orderbook', lower: 'brokers', label: '10호가 / 거래원 크기 조절' },
  { upper: 'brokers', lower: 'volumeDistribution', label: '거래원 / 매물대 크기 조절' },
  { upper: 'volumeDistribution', lower: 'program', label: '매물대 / 프로그램 순매수 크기 조절' },
  { upper: 'program', lower: 'investor', label: '프로그램 순매수 / 잠정투자자 크기 조절' },
];
const RESIZER_HEIGHT_PX = 8;
const WEIGHT_TO_MIN_HEIGHT_PX = 6;

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
  const collapsed = useLiveLayoutStore((state) => state.rightCardCollapsed);
  const toggleCardCollapsed = useLiveLayoutStore((state) => state.toggleCardCollapsed);
  const setAllCardsCollapsed = useLiveLayoutStore((state) => state.setAllCardsCollapsed);
  const setDetailPanelCollapsed = useLiveLayoutStore((state) => state.setDetailPanelCollapsed);
  useEffect(() => () => {
    activeResizeCleanupRef.current?.();
    activeResizeCleanupRef.current = null;
  }, []);
  const cards: CardDef[] = [
    {
      key: 'orderbook',
      label: '10호가',
      testId: 'live-detail-card-orderbook',
      contentTestId: 'card-orderbook',
      content: orderbook,
    },
    {
      key: 'brokers',
      label: '거래원',
      testId: 'live-detail-card-brokers',
      contentTestId: 'card-brokers',
      content: brokers,
    },
    {
      key: 'volumeDistribution',
      label: '매물대',
      testId: 'live-detail-card-volumeDistribution',
      contentTestId: 'card-volume-distribution',
      content: volumeDistribution ?? null,
    },
    {
      key: 'program',
      label: '프로그램 순매수',
      testId: 'live-detail-card-program',
      contentTestId: 'card-program',
      content: program,
    },
    {
      key: 'investor',
      label: '잠정투자자',
      testId: 'live-detail-card-investor',
      contentTestId: 'card-investor',
      content: investor,
    },
  ];

  const beginResize =
    (upper: LiveCardKey, lower: LiveCardKey) => (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      const startY = event.clientY;
      const startWeights = useLiveLayoutStore.getState().rightCardWeights;
      const panelHeight = panelRef.current?.clientHeight ?? 0;
      const totalWeight = Object.values(startWeights).reduce((sum, weight) => sum + weight, 0);
      const pairWeight = startWeights[upper] + startWeights[lower];
      const contentHeight = Math.max(
        0,
        panelHeight - RESIZER_PAIRS.length * RESIZER_HEIGHT_PX,
      );
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

  const allCollapsed = cards.every((card) => collapsed[card.key]);

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
        <button
          type="button"
          data-testid="live-detail-collapse-all"
          onClick={() => setAllCardsCollapsed(!allCollapsed)}
          className="rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-fg-dimmer hover:bg-bg-input-hover hover:text-fg"
        >
          {allCollapsed ? '모두 펴기' : '모두 접기'}
        </button>
      </div>
      <aside
        ref={panelRef}
        data-testid="live-detail-panel"
        className="grid min-h-full flex-1 bg-bg-card"
        style={{
          gridTemplateRows: cards
            .map((card) => (collapsed[card.key] ? 'min-content' : 'auto'))
            .join(' 8px '),
        }}
      >
        {cards.map((card, index) => {
          const isCollapsed = Boolean(collapsed[card.key]);
          const resizer = index < RESIZER_PAIRS.length ? RESIZER_PAIRS[index] : null;
          // 이웃 카드가 하나라도 접혀 있으면 리사이저를 inert 로 — DOM 에는 유지하되
          // 드래그를 비활성(pointerdown 미부착)해 "정확히 4개 separator" 테스트와 8px
          // 행 정렬을 보존한다.
          const resizerInert = resizer
            ? Boolean(collapsed[resizer.upper]) || Boolean(collapsed[resizer.lower])
            : false;
          return (
            <div key={card.key} style={{ display: 'contents' }}>
              <div
                data-testid={card.testId}
                data-card={card.key}
                className={`flex flex-col ${index === 0 ? '' : 'border-t border-border'}`.trim()}
                style={{
                  minHeight: isCollapsed
                    ? undefined
                    : Math.max(
                        LIVE_CARD_MIN_HEIGHT_PX[card.key],
                        Math.round(weights[card.key] * WEIGHT_TO_MIN_HEIGHT_PX),
                      ),
                }}
              >
                <DataSection
                  title={card.label}
                  collapsed={isCollapsed}
                  onToggleCollapse={() => toggleCardCollapsed(card.key)}
                  showEmptyDot={Boolean(emptyByCard?.[card.key])}
                  toggleTestId={`live-detail-toggle-${card.key}`}
                  className="flex flex-1 flex-col border-t-0"
                  contentClassName="flex-1"
                >
                  <div data-testid={`live-detail-content-${card.key}`} className="flex-1">
                    <div data-testid={card.contentTestId}>{card.content}</div>
                  </div>
                </DataSection>
              </div>
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
            </div>
          );
        })}
      </aside>
    </div>
  );
}

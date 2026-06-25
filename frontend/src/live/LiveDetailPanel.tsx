import { type ReactNode, useEffect, useRef } from 'react';
import {
  type LiveCardKey,
  LIVE_CARD_MIN_HEIGHT_PX,
  resizeAdjacentWeights,
  useLiveLayoutStore,
} from '../state/liveLayout';

type Props = {
  orderbook: ReactNode;
  volumeDistribution?: ReactNode;
  program: ReactNode;
  brokers: ReactNode;
  investor: ReactNode;
};

type CardDef = {
  key: LiveCardKey;
  label: string;
  testId: string;
  contentTestId: string;
  content: ReactNode;
};

const RESIZER_PAIRS: Array<{ upper: LiveCardKey; lower: LiveCardKey; label: string }> = [
  { upper: 'orderbook', lower: 'volumeDistribution', label: '10호가 / 매물대 크기 조절' },
  { upper: 'volumeDistribution', lower: 'brokers', label: '매물대 / 거래원 크기 조절' },
  { upper: 'brokers', lower: 'program', label: '거래원 / 프로그램 순매수 크기 조절' },
  { upper: 'program', lower: 'investor', label: '프로그램 순매수 / 잠정투자자 크기 조절' },
];
const RESIZER_HEIGHT_PX = 8;
const WEIGHT_TO_MIN_HEIGHT_PX = 6;

export function LiveDetailPanel({ orderbook, volumeDistribution, program, brokers, investor }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  const weights = useLiveLayoutStore((state) => state.rightCardWeights);
  const setWeights = useLiveLayoutStore((state) => state.setRightCardWeights);
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
      key: 'volumeDistribution',
      label: '매물대',
      testId: 'live-detail-card-volumeDistribution',
      contentTestId: 'card-volume-distribution',
      content: volumeDistribution ?? null,
    },
    {
      key: 'brokers',
      label: '거래원',
      testId: 'live-detail-card-brokers',
      contentTestId: 'card-brokers',
      content: brokers,
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

  return (
    <aside
      ref={panelRef}
      data-testid="live-detail-panel"
      className="grid min-h-full bg-bg p-[var(--space-sm)]"
      style={{
        gridTemplateRows: cards.map(() => 'auto').join(' 8px '),
      }}
    >
      {cards.map((card, index) => (
        <div key={card.key} style={{ display: 'contents' }}>
          <section
            data-testid={card.testId}
            data-card={card.key}
            className="flex flex-col rounded border bg-bg-card"
            style={{
              minHeight: Math.max(
                LIVE_CARD_MIN_HEIGHT_PX[card.key],
                Math.round(weights[card.key] * WEIGHT_TO_MIN_HEIGHT_PX),
              ),
            }}
          >
            <header className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wider text-fg-dimmer">
              {card.label}
            </header>
            <div data-testid={`live-detail-content-${card.key}`} className="flex-1">
              <div data-testid={card.contentTestId}>{card.content}</div>
            </div>
          </section>
          {index < RESIZER_PAIRS.length ? (
            <div
              role="separator"
              aria-label={RESIZER_PAIRS[index].label}
              aria-orientation="horizontal"
              data-testid={`live-detail-resizer-${RESIZER_PAIRS[index].upper}-${RESIZER_PAIRS[index].lower}`}
              className="grid min-h-[8px] cursor-row-resize place-items-center"
              style={{ touchAction: 'none' }}
              onPointerDown={beginResize(RESIZER_PAIRS[index].upper, RESIZER_PAIRS[index].lower)}
            >
              <div aria-hidden className="h-px w-full bg-border" />
            </div>
          ) : null}
        </div>
      ))}
    </aside>
  );
}

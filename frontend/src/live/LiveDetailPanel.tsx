import { type ReactNode, useRef } from 'react';
import {
  type LiveCardKey,
  LIVE_CARD_MIN_HEIGHT_PX,
  resizeAdjacentWeights,
  useLiveLayoutStore,
} from '../state/liveLayout';

type Props = {
  orderbook: ReactNode;
  program: ReactNode;
  brokers: ReactNode;
  investor: ReactNode;
};

type CardDef = {
  key: LiveCardKey;
  label: string;
  testId: string;
  content: ReactNode;
};

const RESIZER_PAIRS: Array<{ upper: LiveCardKey; lower: LiveCardKey; label: string }> = [
  { upper: 'orderbook', lower: 'program', label: '10호가 / 프로그램 순매수 크기 조절' },
  { upper: 'program', lower: 'brokers', label: '프로그램 순매수 / 거래원 크기 조절' },
  { upper: 'brokers', lower: 'investor', label: '거래원 / 잠정투자자 크기 조절' },
];

export function LiveDetailPanel({ orderbook, program, brokers, investor }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const weights = useLiveLayoutStore((state) => state.rightCardWeights);
  const setWeights = useLiveLayoutStore((state) => state.setRightCardWeights);
  const cards: CardDef[] = [
    {
      key: 'orderbook',
      label: '10호가',
      testId: 'live-detail-card-orderbook',
      content: orderbook,
    },
    {
      key: 'program',
      label: '프로그램 순매수',
      testId: 'live-detail-card-program',
      content: program,
    },
    {
      key: 'brokers',
      label: '거래원',
      testId: 'live-detail-card-brokers',
      content: brokers,
    },
    {
      key: 'investor',
      label: '잠정투자자',
      testId: 'live-detail-card-investor',
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

      target.setPointerCapture(event.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextWeights = resizeAdjacentWeights(
          startWeights,
          upper,
          lower,
          moveEvent.clientY - startY,
          panelHeight,
        );
        useLiveLayoutStore.setState({ rightCardWeights: nextWeights });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (target.hasPointerCapture(upEvent.pointerId)) {
          target.releasePointerCapture(upEvent.pointerId);
        }
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        setWeights(useLiveLayoutStore.getState().rightCardWeights);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    };

  return (
    <aside
      ref={panelRef}
      data-testid="live-detail-panel"
      className="grid h-full min-h-0 bg-bg p-[var(--space-sm)]"
      style={{
        gridTemplateRows: cards
          .map((card) => `minmax(${LIVE_CARD_MIN_HEIGHT_PX[card.key]}px, ${weights[card.key]}fr)`)
          .join(' 8px '),
      }}
    >
      {cards.map((card, index) => (
        <div key={card.key} style={{ display: 'contents' }}>
          <section
            data-testid={card.testId}
            data-card={card.key}
            className="flex min-h-0 flex-col overflow-hidden rounded border bg-bg-card"
          >
            <header className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wider text-fg-dimmer">
              {card.label}
            </header>
            <div className="min-h-0 flex-1 overflow-auto">{card.content}</div>
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

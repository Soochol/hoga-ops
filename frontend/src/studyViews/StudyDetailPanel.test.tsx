import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StudyDetailPanel } from './StudyDetailPanel';
import type { StudySnapshotDetailInput } from './studySnapshotAdapter';

function details(overrides: Partial<StudySnapshotDetailInput> = {}): StudySnapshotDetailInput {
  return {
    orderbookByBucketStart: new Map(),
    brokersByBucketStart: new Map(),
    detailWarnings: [],
    volumeDistributionEnabled: true,
    volumeDistributionColor: '#64748B',
    volumeDistributionMaxColor: '#EAB308',
    volumeDistributions: [],
    ...overrides,
  };
}

describe('StudyDetailPanel', () => {
  it('renders 거래원 before 프로그램 in the detail stack', () => {
    render(
      <StudyDetailPanel
        details={details()}
        candles={[{ ts_ms: 1_000 }]}
        segments={[{ date: '20260625', session_open_ms: 1_000, session_close_ms: 2_000, source: 'hogaplay' }]}
        bucketMs={60_000}
        cursorMs={null}
      />,
    );

    const brokers = screen.getByTestId('card-brokers');
    const program = screen.getByTestId('card-program-trade');
    expect(
      brokers.compareDocumentPosition(program) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the saved volume distribution for the hovered segment date even when the cursor is between saved candles', () => {
    render(
      <StudyDetailPanel
        details={details({
          volumeDistributionEnabled: true,
          volumeDistributionColor: '#64748B',
          volumeDistributionMaxColor: '#EAB308',
          volumeDistributions: [
            {
              date: '20260625',
              range_count: 10,
              price_min: 100,
              price_max: 120,
              session_open_ms: 90_000_000,
              session_close_ms: 153_000_000,
              bins: [{ price_low: 100, price_high: 102, qty: 10 }],
            },
            {
              date: '20260626',
              range_count: 10,
              price_min: 200,
              price_max: 220,
              session_open_ms: 190_000_000,
              session_close_ms: 253_000_000,
              bins: [{ price_low: 200, price_high: 202, qty: 20 }],
            },
          ],
        })}
        candles={[{ ts_ms: 190_000_000 }]}
        segments={[
          { date: '20260625', session_open_ms: 90_000_000, session_close_ms: 153_000_000, source: 'hogaplay' },
          { date: '20260626', session_open_ms: 190_000_000, session_close_ms: 253_000_000, source: 'hogaplay' },
        ]}
        bucketMs={60_000}
        cursorMs={190_120_000}
      />,
    );

    expect(screen.getByTestId('volume-distribution-card')).toBeTruthy();
    expect(screen.getAllByTestId('volume-distribution-row')).toHaveLength(1);
    expect(screen.queryByText('100-102')).toBeNull();
    expect(screen.getByTestId('volume-distribution-cursor-marker')).toBeTruthy();
    expect(screen.getByTestId('volume-distribution-max-bar')).toHaveStyle({ backgroundColor: '#EAB308' });
  });

  it('matches saved volume distributions by trading date when daily candle time is outside session hours', () => {
    const candleAtKstMidnight = Date.UTC(2026, 5, 25, 15, 0, 0);
    const sessionOpen = Date.UTC(2026, 5, 26, 0, 0, 0);
    const sessionClose = Date.UTC(2026, 5, 26, 6, 30, 0);

    render(
      <StudyDetailPanel
        details={details({
          volumeDistributionEnabled: true,
          volumeDistributions: [{
            date: '20260626',
            range_count: 10,
            price_min: 100,
            price_max: 120,
            session_open_ms: sessionOpen,
            session_close_ms: sessionClose,
            bins: [
              { price_low: 100, price_high: 102, qty: 10 },
              { price_low: 102, price_high: 104, qty: 30 },
            ],
          }],
        })}
        candles={[{ ts_ms: candleAtKstMidnight, close: 110 }]}
        segments={[{ date: '20260626', session_open_ms: sessionOpen, session_close_ms: sessionClose, source: 'hogaplay' }]}
        bucketMs={86_400_000}
        cursorMs={null}
      />,
    );

    expect(screen.getByTestId('volume-distribution-card')).toBeTruthy();
    expect(screen.getAllByTestId('volume-distribution-row')).toHaveLength(2);
    expect(screen.getByTestId('volume-distribution-max-bar')).toHaveStyle({ backgroundColor: '#EAB308' });
  });
});

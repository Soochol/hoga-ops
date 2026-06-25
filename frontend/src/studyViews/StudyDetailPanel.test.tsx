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
});

import { describe, expect, it } from 'vitest';
import type { Time } from 'lightweight-charts';

import {
  brokerLateEntryMarkerXCoordinate,
  shouldUseFullBrokerLateEntryLabels,
} from './BrokerLateEntryMarkersPrimitive';
import type { BrokerLateEntryMarkerPoint } from './projectors/brokerLateEntryMarkers';

function marker(overrides: Partial<BrokerLateEntryMarkerPoint> = {}): BrokerLateEntryMarkerPoint {
  return {
    time: 100 as Time,
    anchorTime: 90 as Time,
    price: 0,
    broker: '삼성증권',
    label: '삼성',
    side: 'buy',
    color: '#ef4444',
    ...overrides,
  };
}

describe('brokerLateEntryMarkerXCoordinate', () => {
  it('falls back to anchorTime when the event time is not on the chart time scale', () => {
    const m = marker();

    expect(brokerLateEntryMarkerXCoordinate(m, (time) => {
      if (time === m.time) return null;
      if (time === m.anchorTime) return 42;
      return null;
    })).toBe(42);
  });
});

describe('shouldUseFullBrokerLateEntryLabels', () => {
  it('keeps same-bucket labels individual when the stack fits in the pane', () => {
    const markers = [
      marker({ broker: '삼성증권', label: '삼성' }),
      marker({ broker: '키움증권', label: '키움', side: 'sell', color: '#3b82f6' }),
      marker({ broker: '미래에셋증권', label: '미래' }),
    ];
    const plotted = new Map(markers.map((m) => [m, { x: 120, y: 80 }]));

    expect(shouldUseFullBrokerLateEntryLabels(markers, plotted, 900, 240, 15, 14)).toBe(true);
  });

  it('compacts labels when the visible marker density is high', () => {
    const markers = Array.from({ length: 40 }, (_, i) =>
      marker({ time: (100 + i) as Time, anchorTime: (100 + i) as Time, broker: `거래원${i}`, label: `거래${i}` }));
    const plotted = new Map(markers.map((m, i) => [m, { x: i * 4, y: 80 }]));

    expect(shouldUseFullBrokerLateEntryLabels(markers, plotted, 600, 240, 15, 14)).toBe(false);
  });
});

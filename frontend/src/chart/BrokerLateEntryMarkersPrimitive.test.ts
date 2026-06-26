import { describe, expect, it } from 'vitest';
import type { Time } from 'lightweight-charts';

import {
  BROKER_LATE_ENTRY_MARKER_STYLE,
  brokerLateEntryMarkerXCoordinate,
  isBrokerLateEntryMarkerVisibleInPane,
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

describe('BROKER_LATE_ENTRY_MARKER_STYLE', () => {
  it('uses slightly larger broker dots and label text for chart readability', () => {
    expect(BROKER_LATE_ENTRY_MARKER_STYLE.dotRadiusPx).toBe(4);
    expect(BROKER_LATE_ENTRY_MARKER_STYLE.labelFontPx).toBe(13);
  });
});

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

describe('isBrokerLateEntryMarkerVisibleInPane', () => {
  it('does not keep offscreen-future broker labels sticky on the right edge', () => {
    expect(isBrokerLateEntryMarkerVisibleInPane({ x: 620, y: 80 }, 600, 240)).toBe(false);
  });

  it('keeps broker labels visible when their anchor point is inside the pane', () => {
    expect(isBrokerLateEntryMarkerVisibleInPane({ x: 320, y: 80 }, 600, 240)).toBe(true);
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

  it('keeps nearby low-density labels individual so they split before heavy zoom-in', () => {
    const markers = [
      marker({ time: 100 as Time, anchorTime: 100 as Time, broker: '긴이름증권', label: '긴이름' }),
      marker({ time: 101 as Time, anchorTime: 101 as Time, broker: '옆자리증권', label: '옆자리' }),
    ];
    const plotted = new Map([
      [markers[0], { x: 100, y: 80 }],
      [markers[1], { x: 122, y: 80 }],
    ]);

    expect(shouldUseFullBrokerLateEntryLabels(
      markers,
      plotted,
      900,
      240,
      15,
      14,
    )).toBe(true);
  });
});

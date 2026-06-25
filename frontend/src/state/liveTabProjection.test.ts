import { describe, expect, it } from 'vitest';
import type { LiveTab } from './liveTabs';
import {
  mirrorPageViewToActiveTab,
  projectTabToActiveView,
} from './liveTabProjection';
import { stockInstrument } from '../live/liveInstrument';

function tab(overrides: Partial<LiveTab> = {}): LiveTab {
  return {
    id: 'tab-a',
    instrument: stockInstrument('005930', '삼성전자'),
    code: '005930',
    label: '삼성전자',
    timeframe: '1m',
    historicalFromDate: null,
    ...overrides,
  };
}

describe('live tab projection policy', () => {
  it('projects a tab into the active page view while resetting pan to latest fit', () => {
    expect(projectTabToActiveView(tab({ timeframe: 'D', historicalFromDate: '2026-01-02' }), '1m')).toEqual({
      instrument: { kind: 'stock', code: '005930', label: '삼성전자' },
      code: '005930',
      timeframe: 'D',
      historicalFromDate: null,
    });
  });

  it('projects a null tab by clearing the code and preserving the current page timeframe', () => {
    expect(projectTabToActiveView(null, 'D')).toEqual({
      instrument: null,
      code: null,
      timeframe: 'D',
      historicalFromDate: null,
    });
  });

  it('mirrors page timeframe into the active tab while dropping pan', () => {
    const tabs = [tab(), tab({ id: 'tab-b', code: '000660', label: 'SK하이닉스', timeframe: 'D' })];

    expect(
      mirrorPageViewToActiveTab(tabs, 'tab-a', {
        candleTimeframe: 'D',
        historicalFromDate: '2026-01-02',
      }),
    ).toEqual([
      { ...tabs[0], timeframe: 'D', historicalFromDate: null },
      tabs[1],
    ]);
  });

  it('leaves the target tab unchanged when its timeframe already matches', () => {
    const tabs = [tab(), tab({ id: 'tab-b', code: '000660', label: 'SK하이닉스', timeframe: 'D' })];

    expect(
      mirrorPageViewToActiveTab(tabs, 'tab-b', {
        candleTimeframe: 'D',
        historicalFromDate: null,
      }),
    ).toEqual([tabs[0], { ...tabs[1], historicalFromDate: null }]);
  });
});

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
  it('projects a tab into the active page view with its saved viewport', () => {
    const viewport = { rightEdgeMs: 1_781_000_000_000, barSpan: 240, atLiveEdge: false };

    expect(projectTabToActiveView(tab({ timeframe: 'D', historicalFromDate: '2026-01-02', viewport }), '1m')).toEqual({
      instrument: { kind: 'stock', code: '005930', label: '삼성전자' },
      code: '005930',
      timeframe: 'D',
      historicalFromDate: '2026-01-02',
      lastMinuteHistoricalFromDate: null,
      viewport,
    });
  });

  it('projects a null tab by clearing the code and preserving the current page timeframe', () => {
    expect(projectTabToActiveView(null, 'D')).toEqual({
      instrument: null,
      code: null,
      timeframe: 'D',
      historicalFromDate: null,
      lastMinuteHistoricalFromDate: null,
      viewport: null,
    });
  });

  it('projects the tab-carried minute window into the active view', () => {
    const projected = projectTabToActiveView(
      tab({ timeframe: 'D', lastMinuteHistoricalFromDate: '20260601' }),
      '1m',
    );
    expect(projected.lastMinuteHistoricalFromDate).toBe('20260601');
  });

  it('mirrors page timeframe into the active tab while dropping pan and viewport', () => {
    const viewport = { rightEdgeMs: 1_781_000_000_000, barSpan: 240, atLiveEdge: false };
    const tabs = [tab({ viewport }), tab({ id: 'tab-b', code: '000660', label: 'SK하이닉스', timeframe: 'D' })];

    expect(
      mirrorPageViewToActiveTab(tabs, 'tab-a', {
        candleTimeframe: 'D',
        historicalFromDate: '2026-01-02',
        lastMinuteHistoricalFromDate: null,
      }),
    ).toEqual([
      { ...tabs[0], timeframe: 'D', historicalFromDate: null, lastMinuteHistoricalFromDate: null, viewport: null },
      tabs[1],
    ]);
  });

  it('mirrors the page minute window verbatim, including across a timeframe change', () => {
    // 분봉 이탈(1m→D) 커밋: store가 이미 기억을 계산했으므로 미러는 그대로 복사.
    const tabs = [tab()];
    expect(
      mirrorPageViewToActiveTab(tabs, 'tab-a', {
        candleTimeframe: 'D',
        historicalFromDate: null,
        lastMinuteHistoricalFromDate: '20260601',
      }),
    ).toEqual([
      { ...tabs[0], timeframe: 'D', historicalFromDate: null, lastMinuteHistoricalFromDate: '20260601', viewport: null },
    ]);
  });

  it('mirrors a minute-window-only change without touching timeframe or viewport', () => {
    // 복원 dispatch(extendHistoricalRange) 직후처럼 pan과 기억이 함께 변한 경우가
    // 아니라, 기억만 변한 커밋도 미러가 놓치지 않는다(변경 감지 3항).
    const viewport = { rightEdgeMs: 1_781_000_000_000, barSpan: 240, atLiveEdge: false };
    const tabs = [tab({ viewport, timeframe: 'D' })];
    expect(
      mirrorPageViewToActiveTab(tabs, 'tab-a', {
        candleTimeframe: 'D',
        historicalFromDate: null,
        lastMinuteHistoricalFromDate: '20260601',
      }),
    ).toEqual([
      { ...tabs[0], historicalFromDate: null, lastMinuteHistoricalFromDate: '20260601', viewport },
    ]);
  });

  it('leaves the target tab unchanged when its timeframe already matches', () => {
    const tabs = [tab(), tab({ id: 'tab-b', code: '000660', label: 'SK하이닉스', timeframe: 'D' })];

    expect(
      mirrorPageViewToActiveTab(tabs, 'tab-b', {
        candleTimeframe: 'D',
        historicalFromDate: null,
        lastMinuteHistoricalFromDate: null,
      }),
    ).toEqual([tabs[0], { ...tabs[1], historicalFromDate: null }]);
  });
});

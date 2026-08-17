import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useLivePageStore, type LiveTimeframe } from './livePage';
import {
  DEFAULT_LIVE_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  MINUTE_TIMEFRAMES,
  bucketSeconds,
  needsRegularSessionClip,
  fetchBucketMsFor,
  type LiveMAConfig,
} from './livePage';
import { TIMEFRAME_LABELS, TIMEFRAME_TO_MS } from '../api/types';

/** 분봉 tf 목록이 **두 벌**로 존재한다 — `api/types.ts` 의 `Timeframe`
 *  (`TIMEFRAME_TO_MS` 의 키)과 여기 `MinuteTimeframe`. 백엔드 wire 가드는
 *  `LiveTimeframe` 쪽만 보므로, 한쪽만 늘리면 **아무 가드도 안 울린 채** 갈린다.
 *  타입도 못 잡는다 — 서로를 참조하지 않는 독립 union 이라서다. 그 드리프트를
 *  여기서 막는다. */
describe('분봉 tf 두 목록의 동기', () => {
  it('TIMEFRAME_LABELS 와 MINUTE_TIMEFRAMES 가 같은 값·같은 순서다', () => {
    expect([...TIMEFRAME_LABELS]).toEqual([...MINUTE_TIMEFRAMES]);
  });

  it('TIMEFRAME_TO_MS 와 bucketSeconds() 가 같은 폭을 말한다', () => {
    for (const tf of MINUTE_TIMEFRAMES) {
      expect(bucketSeconds(tf)).toBe(TIMEFRAME_TO_MS[tf] / 1000);
    }
  });

  it('클립 대상은 120·240 뿐이다 — 60m 는 #1252 결정대로 둔다', () => {
    for (const tf of MINUTE_TIMEFRAMES) {
      expect(needsRegularSessionClip(tf)).toBe(tf === '120m' || tf === '240m');
    }
  });

  it('클립 대상만 30m 로 받고 나머지는 표시 tf 그대로 받는다', () => {
    // 30m 인 이유는 커버리지가 아니라 **경계 보존**이다 — 15:30 이 봉 경계로 남아야
    // 봉 단위 클립이 성립한다. 표시 tf 로 받으면 이미 혼합된 봉이라 손쓸 수 없다.
    expect(fetchBucketMsFor('120m')).toBe(1_800_000);
    expect(fetchBucketMsFor('240m')).toBe(1_800_000);
    for (const tf of MINUTE_TIMEFRAMES) {
      if (needsRegularSessionClip(tf)) continue;
      expect(fetchBucketMsFor(tf)).toBe(TIMEFRAME_TO_MS[tf]);
    }
  });

  it('클립 tf 의 표시 버킷은 fetch 버킷의 정수배다 (걸치는 봉 없음)', () => {
    for (const tf of MINUTE_TIMEFRAMES) {
      expect(TIMEFRAME_TO_MS[tf] % fetchBucketMsFor(tf)).toBe(0);
    }
  });

  it('모든 분봉 버킷이 09:00 격자에 정렬된다 (86,400,000 % bucket === 0)', () => {
    // KST 09:00 ≡ UTC 00:00 이고 `aggregateCandles` 는 epoch-floor 다 — 버킷이
    // 하루를 나누지 못하면 봉 하나가 개장을 가로질러 전날·당일이 섞인다.
    // 백엔드 `BUCKET_MS_TO_TIC_SCOPE` 의 같은 단언과 짝이다.
    for (const tf of MINUTE_TIMEFRAMES) {
      expect(86_400_000 % TIMEFRAME_TO_MS[tf]).toBe(0);
    }
  });
});

describe('livePage store', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      lastMinuteTimeframe: '1m',
      historicalFromDate: null,
      lastMinuteHistoricalFromDate: null,
    });
  });

  it('starts with sensible defaults', () => {
    const { activeCode, candleTimeframe } = useLivePageStore.getState();
    expect(activeCode).toBeNull();
    expect(candleTimeframe).toBe('1m');
  });

  it('setActiveCode updates state and persists', () => {
    useLivePageStore.getState().setActiveCode('005930');
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    expect(localStorage.getItem('live.page.v1')).toContain('005930');
  });

  it('projectActiveView sets code + timeframe + historicalFromDate atomically and persists', () => {
    useLivePageStore.getState().projectActiveView({
      code: '005930', timeframe: '5m', historicalFromDate: '20260601',
    });
    const s = useLivePageStore.getState();
    expect(s.activeCode).toBe('005930');
    expect(s.candleTimeframe).toBe('5m');
    expect(s.historicalFromDate).toBe('20260601');
    const raw = JSON.parse(localStorage.getItem('live.page.v1') ?? '{}');
    expect(raw.activeCode).toBe('005930');
    expect(raw.candleTimeframe).toBe('5m');
    expect(raw.historicalFromDate).toBe('20260601');
  });

  it('projectActiveView with a null pan clears historicalFromDate (no leftover from a prior code)', () => {
    useLivePageStore.getState().projectActiveView({ code: 'A', timeframe: '1m', historicalFromDate: '20260101' });
    useLivePageStore.getState().projectActiveView({ code: 'B', timeframe: '1m', historicalFromDate: null });
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('projectActiveView falls back to the current timeframe when given an invalid one', () => {
    useLivePageStore.getState().projectActiveView({ code: 'Z', timeframe: '5m', historicalFromDate: null });
    // @ts-expect-error — deliberately invalid timeframe to test the clamp
    useLivePageStore.getState().projectActiveView({ code: 'A', timeframe: 'NOPE', historicalFromDate: null });
    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
    expect(useLivePageStore.getState().activeCode).toBe('A');
  });

  it('hydrates from localStorage on read', () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({ activeCode: '000660', candleTimeframe: '5m' }),
    );
    // Re-import via dynamic to re-trigger hydration; simulate fresh session via setState from a hydration helper.
    useLivePageStore.getState().hydrateFromStorage();
    expect(useLivePageStore.getState().activeCode).toBe('000660');
    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
  });

  it('falls back to 1m on initial import when legacy storage omits lastMinuteTimeframe', async () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({
        activeCode: '000660',
        candleTimeframe: 'D',
        historicalFromDate: null,
      }),
    );

    vi.resetModules();
    const { useLivePageStore: freshStore } = await import('./livePage');
    const state = freshStore.getState();

    expect(state.activeCode).toBe('000660');
    expect(state.candleTimeframe).toBe('D');
    expect(state.lastMinuteTimeframe).toBe('1m');
  });

  it('tracks the last selected minute timeframe', () => {
    const view = (timeframe: LiveTimeframe) =>
      useLivePageStore.getState().projectActiveView({ code: 'A', timeframe, historicalFromDate: null });

    view('10m');
    expect(useLivePageStore.getState().candleTimeframe).toBe('10m');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');

    view('D');
    expect(useLivePageStore.getState().candleTimeframe).toBe('D');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');
  });

  it('persists and hydrates lastMinuteTimeframe', () => {
    const view = (timeframe: LiveTimeframe) =>
      useLivePageStore.getState().projectActiveView({ code: 'A', timeframe, historicalFromDate: null });

    view('15m');
    view('W');

    const raw = JSON.parse(localStorage.getItem('live.page.v1') ?? '{}');
    expect(raw.candleTimeframe).toBe('W');
    expect(raw.lastMinuteTimeframe).toBe('15m');

    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      lastMinuteTimeframe: '1m',
      historicalFromDate: null,
    });
    useLivePageStore.getState().hydrateFromStorage();
    expect(useLivePageStore.getState().candleTimeframe).toBe('W');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('15m');
  });

  it('derives missing lastMinuteTimeframe from stored minute candleTimeframe', () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({ activeCode: '000660', candleTimeframe: '5m', historicalFromDate: null }),
    );

    useLivePageStore.getState().hydrateFromStorage();

    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('5m');
  });

  it('falls back to 1m when stored lastMinuteTimeframe is invalid or missing on calendar timeframe', () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({
        activeCode: '000660',
        candleTimeframe: 'D',
        historicalFromDate: null,
        lastMinuteTimeframe: 'bogus',
      }),
    );

    useLivePageStore.getState().hydrateFromStorage();

    expect(useLivePageStore.getState().candleTimeframe).toBe('D');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('1m');
  });

  it('projectActiveView updates lastMinuteTimeframe only for minute projections', () => {
    useLivePageStore.getState().projectActiveView({
      code: '005930',
      timeframe: '10m',
      historicalFromDate: null,
    });
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');

    useLivePageStore.getState().projectActiveView({
      code: '005930',
      timeframe: 'M',
      historicalFromDate: null,
    });
    expect(useLivePageStore.getState().candleTimeframe).toBe('M');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');
  });

  // 「분봉을 떠나는 순간의 pan 창 기억」 4건은 `setCandleTimeframe` 과 함께 옮겨졌다.
  // 그 액션은 프로덕션 호출자가 0이었고, 실제 봉 전환 경로는 워크스페이스의
  // `setChartTimeframe`(창별 런타임)이다 — 같은 semantics 를 그쪽에서 재는 것이
  // 프로덕션을 재는 것이다. 커버는 `workspace.chartConfig.test.ts` 의 4건:
  // 무효 봉 no-op · 분봉 기억 · pan 창 기억+백필 리셋 · `??` 폴백 · D→W hop.

  it('setActiveCode clears the remembered minute window (per-symbol coverage)', () => {
    useLivePageStore.setState({ lastMinuteHistoricalFromDate: '20250712' });
    useLivePageStore.getState().setActiveCode('005930');
    expect(useLivePageStore.getState().lastMinuteHistoricalFromDate).toBeNull();
  });

  it('resetHistoricalRange clears the remembered minute window too', () => {
    useLivePageStore.setState({
      historicalFromDate: '20250712',
      lastMinuteHistoricalFromDate: '20250712',
    });
    useLivePageStore.getState().resetHistoricalRange();
    const s = useLivePageStore.getState();
    expect(s.historicalFromDate).toBeNull();
    expect(s.lastMinuteHistoricalFromDate).toBeNull();
  });

  it('projectActiveView prefers the tab-carried minute window over the derive fallback', () => {
    // 탭별 미러 경로: D 탭이 분봉 창 기억을 들고 오면 derive(비분봉→null)를
    // 무시하고 그대로 재시드한다 — D 상태 탭 왕복에서 기억이 살아남는 근거.
    useLivePageStore.getState().projectActiveView({
      code: '005930',
      timeframe: 'D',
      historicalFromDate: null,
      lastMinuteHistoricalFromDate: '20250601',
    });
    expect(useLivePageStore.getState().lastMinuteHistoricalFromDate).toBe('20250601');
  });

  it('projectActiveView re-seeds the remembered window from the projected tab', () => {
    useLivePageStore.setState({ lastMinuteHistoricalFromDate: '20240101' }); // 이전 탭 잔재
    useLivePageStore.getState().projectActiveView({
      code: '005930',
      timeframe: '5m',
      historicalFromDate: '20250601',
    });
    expect(useLivePageStore.getState().lastMinuteHistoricalFromDate).toBe('20250601');

    useLivePageStore.getState().projectActiveView({
      code: '005930',
      timeframe: 'D',
      historicalFromDate: '20250601',
    });
    // 비분봉 탭으로의 투영은 분봉 창 기억을 남기지 않는다.
    expect(useLivePageStore.getState().lastMinuteHistoricalFromDate).toBeNull();
  });
});

describe('useLivePageStore.setPaneOrder', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({
      paneOrder: [
        'candle', 'volume', 'quote-totals', 'ratio',
        'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution',
      ],
    });
  });

  it('replaces the order (normalized) and persists to live.indicators.v2', () => {
    useLivePageStore.getState().setPaneOrder([
      'candle', 'quote-totals', 'volume', 'ratio',
      'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution',
    ]);
    expect(useLivePageStore.getState().paneOrder.slice(0, 3)).toEqual([
      'candle', 'quote-totals', 'volume',
    ]);
    const persisted = JSON.parse(localStorage.getItem('live.indicators.v2') ?? '{}');
    expect(persisted.paneOrder.slice(0, 3)).toEqual(['candle', 'quote-totals', 'volume']);
  });

  it('normalizes candle back to index 0 even if passed elsewhere', () => {
    useLivePageStore.getState().setPaneOrder(['volume', 'candle', 'ratio'] as never);
    expect(useLivePageStore.getState().paneOrder[0]).toBe('candle');
  });
});

describe('useLivePageStore.setPaneStretch', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({ paneStretch: {} });
  });

  it('merges the patch and persists to live.indicators.v2', () => {
    useLivePageStore.getState().setPaneStretch({ candle: 2.5, volume: 0.2 });
    useLivePageStore.getState().setPaneStretch({ ratio: 0.6 });
    expect(useLivePageStore.getState().paneStretch).toEqual({ candle: 2.5, volume: 0.2, ratio: 0.6 });
    const persisted = JSON.parse(localStorage.getItem('live.indicators.v2') ?? '{}');
    expect(persisted.paneStretch).toEqual({ candle: 2.5, volume: 0.2, ratio: 0.6 });
  });

  it('drops invalid entries (unknown key, non-finite, out-of-range)', () => {
    useLivePageStore.getState().setPaneStretch({
      candle: 1.8,
      nope: 1,
      volume: Number.NaN,
      ratio: 0,
      'quote-totals': 999,
    } as never);
    expect(useLivePageStore.getState().paneStretch).toEqual({ candle: 1.8 });
  });

  it('resetIndicators preserves paneStretch (layout, like paneOrder)', () => {
    useLivePageStore.getState().setPaneStretch({ candle: 2.5 });
    useLivePageStore.getState().resetIndicators();
    expect(useLivePageStore.getState().paneStretch).toEqual({ candle: 2.5 });
  });

  it('applyIndicatorPreset replaces paneStretch wholesale ({} resets to spec defaults)', () => {
    useLivePageStore.getState().setPaneStretch({ candle: 2.5 });
    useLivePageStore.getState().applyIndicatorPreset({
      paneOrder: ['candle'],
      byTimeframeEnable: {},
      paneStretch: {},
    });
    expect(useLivePageStore.getState().paneStretch).toEqual({});
  });
});

describe('useLivePageStore.movingAverages', () => {
  beforeEach(() => {
    localStorage.removeItem('live.indicators.v1');
    localStorage.removeItem('live.indicators.v2');
    // Force re-hydrate by resetting state to DEFAULT_LIVE_MAS clone.
    useLivePageStore.setState({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
    });
  });

  it('starts with DEFAULT_LIVE_MAS clone (4 entries)', () => {
    expect(useLivePageStore.getState().movingAverages).toHaveLength(4);
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(5);
  });

  it('setMovingAverage patches one slot, preserves others by reference', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().setMovingAverage(before[1].id, { period: 25 });
    const after = useLivePageStore.getState().movingAverages;
    expect(after[1].period).toBe(25);
    expect(after[1].enabled).toBe(before[1].enabled);
    // Untouched slots are referentially equal (immutable patch).
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });

  it('setMovingAverage clamps period to [MA_PERIOD_MIN, MA_PERIOD_MAX]', () => {
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { period: 1 });
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(2);
    useLivePageStore.getState().setMovingAverage(id, { period: 1000 });
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(400);
  });

  it('setMovingAverage floors non-integer period', () => {
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { period: 3.7 });
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(3);
  });

  it('setMovingAverage is no-op for unknown id', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().setMovingAverage('nope', { period: 99 });
    expect(useLivePageStore.getState().movingAverages).toBe(before);
  });

  it('addMovingAverage appends with new id, period = prev * 2 capped', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().addMovingAverage();
    const after = useLivePageStore.getState().movingAverages;
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1].period).toBe(Math.min(120 * 2, 400));
    // id is unique
    expect(new Set(after.map((m) => m.id)).size).toBe(after.length);
  });

  it('addMovingAverage is no-op when MA_SLOT_LIMIT reached', () => {
    // Fill to limit.
    while (useLivePageStore.getState().movingAverages.length < MA_SLOT_LIMIT) {
      useLivePageStore.getState().addMovingAverage();
    }
    const at_limit = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().addMovingAverage();
    expect(useLivePageStore.getState().movingAverages).toBe(at_limit);
  });

  it('removeMovingAverage drops the entry', () => {
    const before = useLivePageStore.getState().movingAverages;
    const targetId = before[1].id;
    useLivePageStore.getState().removeMovingAverage(targetId);
    const after = useLivePageStore.getState().movingAverages;
    expect(after).toHaveLength(before.length - 1);
    expect(after.find((m) => m.id === targetId)).toBeUndefined();
  });

  it('removeMovingAverage refuses to drop the last slot', () => {
    // Reduce to 1.
    const ids = useLivePageStore.getState().movingAverages.map((m) => m.id);
    for (const id of ids.slice(1)) {
      useLivePageStore.getState().removeMovingAverage(id);
    }
    expect(useLivePageStore.getState().movingAverages).toHaveLength(1);
    const single = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().removeMovingAverage(single[0].id);
    expect(useLivePageStore.getState().movingAverages).toBe(single);
  });

  it('removeMovingAverage is no-op for unknown id', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().removeMovingAverage('nope');
    expect(useLivePageStore.getState().movingAverages).toBe(before);
  });

  it('mutations persist to localStorage("live.indicators.v2") under the ambient bucket', () => {
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { period: 7 });
    const raw = localStorage.getItem('live.indicators.v2');
    expect(raw).toContain('"period":7');

    useLivePageStore.getState().setVolumeDistributionHoverCutoffEnabled(true);
    const persisted = JSON.parse(localStorage.getItem('live.indicators.v2')!);
    const bucketKey = useLivePageStore.getState().indicatorTimeframe === 'D' ? 'D' : 'minute';
    expect(persisted.byTimeframe[bucketKey].volumeDistributionHoverCutoffEnabled).toBe(true);
  });
});

describe('useLivePageStore.askPeakAllPriceStyle', () => {
  beforeEach(() => {
    localStorage.removeItem('live.indicators.v1');
    localStorage.removeItem('live.indicators.v2');
    useLivePageStore.setState({
      askPeakAllPriceColor: '#F97316',
      askPeakAllPriceLineWidth: 1,
    });
  });

  it('setAskPeakAllPriceStyle updates color and width independently', () => {
    useLivePageStore.getState().setAskPeakAllPriceStyle({ color: '#22C55E' });
    expect(useLivePageStore.getState().askPeakAllPriceColor).toBe('#22C55E');
    expect(useLivePageStore.getState().askPeakAllPriceLineWidth).toBe(1);

    useLivePageStore.getState().setAskPeakAllPriceStyle({ lineWidth: 4 });
    expect(useLivePageStore.getState().askPeakAllPriceColor).toBe('#22C55E');
    expect(useLivePageStore.getState().askPeakAllPriceLineWidth).toBe(4);
  });

  it('persists all-price style fields in the indicator snapshot', () => {
    useLivePageStore.getState().setAskPeakAllPriceStyle({ color: '#22C55E', lineWidth: 3 });
    const raw = JSON.parse(localStorage.getItem('live.indicators.v2') ?? '{}');
    const bucket = raw.byTimeframe?.[useLivePageStore.getState().indicatorTimeframe === 'D' ? 'D' : 'minute'] ?? {};
    expect(bucket.askPeakAllPriceColor).toBe('#22C55E');
    expect(bucket.askPeakAllPriceLineWidth).toBe(3);
  });
});

describe('useLivePageStore.askPeakVisibleMaxStyle', () => {
  beforeEach(() => {
    localStorage.removeItem('live.indicators.v1');
    localStorage.removeItem('live.indicators.v2');
    useLivePageStore.setState({
      askPeakVisibleMaxColor: '#EAB308',
      askPeakVisibleMaxLineWidth: 3,
    });
  });

  it('setAskPeakVisibleMaxStyle updates color and width independently', () => {
    useLivePageStore.getState().setAskPeakVisibleMaxStyle({ color: '#A855F7' });
    expect(useLivePageStore.getState().askPeakVisibleMaxColor).toBe('#A855F7');
    expect(useLivePageStore.getState().askPeakVisibleMaxLineWidth).toBe(3);

    useLivePageStore.getState().setAskPeakVisibleMaxStyle({ lineWidth: 4 });
    expect(useLivePageStore.getState().askPeakVisibleMaxColor).toBe('#A855F7');
    expect(useLivePageStore.getState().askPeakVisibleMaxLineWidth).toBe(4);
  });

  it('persists visible max style fields in the indicator snapshot', () => {
    useLivePageStore.getState().setAskPeakVisibleMaxStyle({ color: '#A855F7', lineWidth: 4 });
    const raw = JSON.parse(localStorage.getItem('live.indicators.v2') ?? '{}');
    const bucket = raw.byTimeframe?.[useLivePageStore.getState().indicatorTimeframe === 'D' ? 'D' : 'minute'] ?? {};
    expect(bucket.askPeakVisibleMaxColor).toBe('#A855F7');
    expect(bucket.askPeakVisibleMaxLineWidth).toBe(4);
  });
});

describe('useLivePageStore.viLimitPriceLineStyle', () => {
  beforeEach(() => {
    localStorage.removeItem('live.indicators.v1');
    localStorage.removeItem('live.indicators.v2');
    useLivePageStore.setState({
      viLimitPriceLineColor: '#EAB308',
      viLimitPriceLineWidth: 3,
    });
  });

  it('setViLimitPriceLineStyle updates color and width independently', () => {
    useLivePageStore.getState().setViLimitPriceLineStyle({ color: '#A855F7' });
    expect(useLivePageStore.getState().viLimitPriceLineColor).toBe('#A855F7');
    expect(useLivePageStore.getState().viLimitPriceLineWidth).toBe(3);

    useLivePageStore.getState().setViLimitPriceLineStyle({ lineWidth: 4 });
    expect(useLivePageStore.getState().viLimitPriceLineColor).toBe('#A855F7');
    expect(useLivePageStore.getState().viLimitPriceLineWidth).toBe(4);
  });

  it('persists VI/상하한가 line style fields in the indicator snapshot', () => {
    useLivePageStore.getState().setViLimitPriceLineStyle({ color: '#A855F7', lineWidth: 4 });
    const raw = JSON.parse(localStorage.getItem('live.indicators.v2') ?? '{}');
    const bucket = raw.byTimeframe?.[useLivePageStore.getState().indicatorTimeframe === 'D' ? 'D' : 'minute'] ?? {};
    expect(bucket.viLimitPriceLineColor).toBe('#A855F7');
    expect(bucket.viLimitPriceLineWidth).toBe(4);
  });
});

describe('LiveMAConfig constants', () => {
  it('exposes period bounds and slot limit', () => {
    expect(MA_PERIOD_MIN).toBe(2);
    expect(MA_PERIOD_MAX).toBe(400);
    expect(MA_SLOT_LIMIT).toBe(8);
  });

  it('DEFAULT_LIVE_MAS has 4 entries (5/20/60/120, all enabled, close, 1px)', () => {
    expect(DEFAULT_LIVE_MAS).toHaveLength(4);
    expect(DEFAULT_LIVE_MAS.map((m: LiveMAConfig) => m.period)).toEqual([5, 20, 60, 120]);
    expect(DEFAULT_LIVE_MAS.every((m: LiveMAConfig) => m.enabled)).toBe(true);
    expect(DEFAULT_LIVE_MAS.every((m: LiveMAConfig) => m.source === 'close')).toBe(true);
    expect(DEFAULT_LIVE_MAS.every((m: LiveMAConfig) => m.lineWidth === 1)).toBe(true);
  });

  it('DEFAULT_LIVE_MAS ids are unique', () => {
    const ids = DEFAULT_LIVE_MAS.map((m: LiveMAConfig) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('DEFAULT_LIVE_MAS is frozen (Object.freeze)', () => {
    expect(Object.isFrozen(DEFAULT_LIVE_MAS)).toBe(true);
  });
});

/**
 * 저장 페이로드 가드.
 *
 * **막는 것**: `persist({ ...get(), ... })` 가 스토어 전체를 흘려보내는 회귀. 호출부가
 * 전부 스프레드 객체 리터럴이라 **TS 초과 프로퍼티 검사가 안 걸린다** — 파라미터 타입이
 * `Persisted`(5필드)여도 컴파일러는 아무 말도 하지 않는다. 실제로 그렇게 새고 있었다:
 * 실측 **85키 3,059B 중 되읽히는 것은 5키 119B**(공장 기본값 기준, 봉·종목·범위 전환마다
 * 매번 기록).
 *
 * **못 보는 것**: 저장 *값*의 정확성. 여기서 재는 것은 키 집합뿐이다.
 *
 * **등록 의존**: 아래 `PERSISTED_KEYS` 는 `livePage.ts` 의 `Persisted` 타입과 손으로
 * 맞춘 사본이다(상수를 공유하면 둘이 함께 틀려도 통과하는 순환 논증이 된다). 필드를
 * 늘리면 두 곳을 같이 고쳐야 한다.
 */
describe('live.page.v1 저장 페이로드', () => {
  const PERSISTED_KEYS = [
    'activeCode',
    'activeInstrument',
    'candleTimeframe',
    'historicalFromDate',
    'lastMinuteTimeframe',
  ];

  const stored = (): Record<string, unknown> =>
    JSON.parse(localStorage.getItem('live.page.v1') ?? '{}') as Record<string, unknown>;

  /** persist 를 부르는 액션 전수 — 하나라도 빠지면 그 경로의 누출을 못 본다. */
  const writers: Record<string, () => void> = {
    projectActiveView: () =>
      useLivePageStore
        .getState()
        .projectActiveView({ code: '005930', timeframe: '5m', historicalFromDate: null }),
    setActiveCode: () => useLivePageStore.getState().setActiveCode('005930'),
    extendHistoricalRange: () => useLivePageStore.getState().extendHistoricalRange('20260101'),
    resetHistoricalRange: () => useLivePageStore.getState().resetHistoricalRange(),
  };

  it.each(Object.keys(writers))('%s 는 Persisted 5키만 쓴다', (name) => {
    writers[name]();
    expect(Object.keys(stored()).sort()).toEqual(PERSISTED_KEYS);
  });

  it('지표 flat 필드·버킷·ambient 슬롯이 저장 블롭에 새지 않는다', () => {
    // 이 셋이 누출의 대표다 — flat 74개 · 4버킷 원본 · 전역 봉 슬롯.
    useLivePageStore.setState({
      askPeakEnabled: true,
      indicatorsByTimeframe: { minute: { askPeakEnabled: true } },
      indicatorTimeframe: '5m',
    });
    useLivePageStore.getState().setActiveCode('005930');

    const raw = stored();
    expect(raw).not.toHaveProperty('askPeakEnabled');
    expect(raw).not.toHaveProperty('indicatorsByTimeframe');
    expect(raw).not.toHaveProperty('indicatorTimeframe');
    expect(raw).not.toHaveProperty('lastMinuteHistoricalFromDate'); // 런타임 전용
  });

  it('레거시 워크스페이스 시드가 읽는 네 필드는 살아 있다', () => {
    // workspaceMigration.readLegacyWorkspaceSeed 의 입력 — 이게 빠지면 `live.workspace.v1`
    // 부재 시 시드가 조용히 비고, 증상은 새 사용자에게만 나타난다.
    useLivePageStore
      .getState()
      .projectActiveView({ code: '005930', timeframe: '5m', historicalFromDate: null });

    const raw = stored();
    for (const key of ['activeInstrument', 'activeCode', 'candleTimeframe', 'lastMinuteTimeframe']) {
      expect(raw).toHaveProperty(key);
    }
  });
});

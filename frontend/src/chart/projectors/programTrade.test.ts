import { describe, expect, it, vi } from 'vitest';
import { LineSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { createVirtualAxis } from '../../util/virtualAxis';
import { mergeProgramTradeSeriesWithLiveTail } from '../../live/programTradeLiveTail';
import { filterProgramTradeForCandles } from '../../live/buildLiveBundle';
import {
  PROGRAM_TRADE_SPEC,
  projectProgramTradeNetAmount,
  findSegmentIdxByTime,
  makeCachedProgramTradeProjector,
} from './programTrade';

const OPEN = Date.UTC(2026, 4, 12, 0, 0, 0);
const CLOSE = Date.UTC(2026, 4, 12, 6, 30, 0);
const NEXT_OPEN = Date.UTC(2026, 4, 13, 0, 0, 0);
const NEXT_CLOSE = Date.UTC(2026, 4, 13, 6, 30, 0);
const EXTENDED_OPEN = Date.UTC(2026, 4, 11, 23, 0, 0);
const EXTENDED_CLOSE = Date.UTC(2026, 4, 12, 11, 0, 0);
const HIDDEN_COLOR = 'rgba(0,0,0,0)';

function quotePoint(t: number, synthetic = false): RangeBundle['quote_ratio']['points'][number] {
  return {
    t,
    bid_total: synthetic ? 0 : 100,
    ask_total: synthetic ? 0 : 120,
    bid_max: synthetic ? 0 : 60,
    ask_max: synthetic ? 0 : 70,
    imb_max_bid: synthetic ? 0 : 40,
    imb_max_ask: synthetic ? 0 : 50,
    band_pct: 0, tick: 0,
    ...(synthetic ? { __syntheticHogaGap: true } : {}),
  } as RangeBundle['quote_ratio']['points'][number];
}

function bucketStart(t: number): number {
  return OPEN + Math.floor((t - OPEN) / 60_000) * 60_000;
}

function bundle(
  points: NonNullable<RangeBundle['program_trade']>['points'],
  quoteTimes = points.map((p) => bucketStart(p.t)),
): RangeBundle {
  return {
    code: '005930',
    from_date: '20260512',
    to_date: '20260512',
    bucket_ms: 60_000,
    segments: [{ date: '20260512', session_open_ms: OPEN, session_close_ms: CLOSE }],
    candles: [],
    quote_ratio: { bucket_ms: 60_000, points: quoteTimes.map((t) => quotePoint(t)) },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    investorPoints: [],
    ask_peaks: [],
    volume_distributions: [],
    broker_late_entries: [],
    program_trade: { points },
  };
}

describe('programTrade projector', () => {
  it('uses a line series for cumulative program net amount', () => {
    expect(PROGRAM_TRADE_SPEC.series[0].type).toBe(LineSeries);
  });

  it('uses the live bundle because it aligns to hoga time slots', () => {
    expect(PROGRAM_TRADE_SPEC.bundleKind).toBe('live');
  });

  it('maps program_trade.points to signed cumulative net-amount line data', () => {
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);
    const out = projectProgramTradeNetAmount(bundle([
      { t: OPEN + 60_000, net_qty: 100, net_amount: 1_500_000, delta_amount: 1_500_000, gap_risk: false },
      { t: OPEN + 120_000, net_qty: -30, net_amount: -400_000, delta_amount: -1_900_000, gap_risk: false },
    ]), axis);

    expect(out.map((p) => ({ time: p.time, value: p.value }))).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 1_500_000 },
      { time: axis.toVirtual(OPEN + 120_000) / 1000, value: -400_000 },
    ]);
    expect('color' in out[0]).toBe(false);
  });

  it('uses the latest cumulative value inside each display bucket', () => {
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);
    const out = projectProgramTradeNetAmount(bundle([
      { t: OPEN + 60_005, net_qty: 100, net_amount: 1_000_000, gap_risk: false },
      { t: OPEN + 60_030, net_qty: 110, net_amount: 1_100_000, gap_risk: false },
      { t: OPEN + 119_999, net_qty: 120, net_amount: 1_200_000, gap_risk: false },
    ]), axis);

    expect(out).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 1_200_000 },
    ]);
  });

  it('returns [] when the optional sidecar is absent', () => {
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);
    const b = bundle([]);
    delete b.program_trade;
    expect(projectProgramTradeNetAmount(b, axis)).toEqual([]);
  });

  it('does not render program points in the NXT extended-hours window', () => {
    const b = bundle([
      { t: EXTENDED_OPEN + 30 * 60_000, net_qty: 10, net_amount: 100_000, gap_risk: false },
      { t: OPEN + 60_000, net_qty: 20, net_amount: 200_000, gap_risk: false },
      { t: CLOSE + 30 * 60_000, net_qty: 30, net_amount: 300_000, gap_risk: false },
    ], [OPEN + 60_000]);
    b.segments = [{ date: '20260512', session_open_ms: EXTENDED_OPEN, session_close_ms: EXTENDED_CLOSE }];
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: EXTENDED_OPEN, sessionCloseMs: EXTENDED_CLOSE }], EXTENDED_OPEN);

    expect(projectProgramTradeNetAmount(b, axis)).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 200_000 },
    ]);
  });

  it('does not render program points in the closing auction window', () => {
    const auctionStart = CLOSE - 10 * 60_000;
    const b = bundle([
      { t: auctionStart - 60_000, net_qty: 10, net_amount: 100_000, gap_risk: false },
      { t: auctionStart, net_qty: 20, net_amount: 200_000, gap_risk: false },
      { t: auctionStart + 60_000, net_qty: 30, net_amount: 300_000, gap_risk: false },
      { t: CLOSE, net_qty: 40, net_amount: 400_000, gap_risk: false },
    ], [
      auctionStart - 60_000,
      auctionStart,
      auctionStart + 60_000,
      CLOSE,
    ]);
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);

    expect(projectProgramTradeNetAmount(b, axis)).toEqual([
      { time: axis.toVirtual(auctionStart - 60_000) / 1000, value: 100_000 },
    ]);
  });

  it('breaks the connector across hoga gap sentinels like quote totals', () => {
    const b = bundle([
      { t: OPEN + 60_000, net_qty: 10, net_amount: 100_000, gap_risk: false },
      { t: OPEN + 180_000, net_qty: 20, net_amount: 200_000, gap_risk: false },
    ], []);
    b.quote_ratio.points = [
      quotePoint(OPEN + 60_000),
      quotePoint(OPEN + 120_000, true),
      quotePoint(OPEN + 180_000),
    ];
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);

    expect(projectProgramTradeNetAmount(b, axis)).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 100_000, color: HIDDEN_COLOR },
      { time: axis.toVirtual(OPEN + 120_000) / 1000, value: 0, color: HIDDEN_COLOR },
      { time: axis.toVirtual(OPEN + 180_000) / 1000, value: 200_000 },
    ]);
  });

  it('breaks the connector across trading-day boundaries', () => {
    const b = bundle([
      { t: OPEN + 60_000, net_qty: 10, net_amount: 100_000, gap_risk: false },
      { t: NEXT_OPEN + 60_000, net_qty: 20, net_amount: 200_000, gap_risk: false },
    ], []);
    b.to_date = '20260513';
    b.segments = [
      { date: '20260512', session_open_ms: OPEN, session_close_ms: CLOSE },
      { date: '20260513', session_open_ms: NEXT_OPEN, session_close_ms: NEXT_CLOSE },
    ];
    b.quote_ratio.points = [
      quotePoint(OPEN + 60_000),
      quotePoint(NEXT_OPEN + 60_000),
    ];
    const axis = createVirtualAxis([
      { date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE },
      { date: '20260513', sessionOpenMs: NEXT_OPEN, sessionCloseMs: NEXT_CLOSE },
    ], OPEN);

    expect(projectProgramTradeNetAmount(b, axis)).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 100_000, color: HIDDEN_COLOR },
      { time: axis.toVirtual(NEXT_OPEN + 60_000) / 1000, value: 200_000 },
    ]);
  });

  it('matches program points to hoga time slots by display bucket', () => {
    const b = bundle([
      { t: OPEN + 60_006, net_qty: 10, net_amount: 100_000, gap_risk: false },
      { t: OPEN + 120_006, net_qty: 20, net_amount: 200_000, gap_risk: false },
    ], []);
    b.quote_ratio.points = [
      quotePoint(OPEN + 60_004),
      quotePoint(OPEN + 120_004),
    ];
    const axis = createVirtualAxis([{ date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);

    expect(projectProgramTradeNetAmount(b, axis)).toEqual([
      { time: axis.toVirtual(OPEN + 60_000) / 1000, value: 100_000 },
      { time: axis.toVirtual(OPEN + 120_000) / 1000, value: 200_000 },
    ]);
  });
});

// 0 기준선 가드. **막는 방향**: 기준선이 사라지는 회귀(afterAdd 삭제 / 오토스케일
// 프로바이더 제거)를 잡는다. **못 보는 것**: 픽셀 렌더링 — createPriceLine 호출과
// 프로바이더의 반환 범위만 재고, lwc 가 실제로 그 선을 칠하는지는 확인하지 않는다.
describe('PROGRAM_TRADE_SPEC zero baseline', () => {
  function resolvedOptions() {
    const opts = PROGRAM_TRADE_SPEC.series[0].options;
    return (typeof opts === 'function' ? opts() : opts) as {
      autoscaleInfoProvider?: (
        o: () => unknown,
      ) => { priceRange: { minValue: number; maxValue: number } } | null;
      lastValueVisible?: boolean;
      priceLineVisible?: boolean;
    };
  }

  // 값 판독면은 Pane Legend 하나로 유지한다(2026-08-18 에 `LEGEND_CELL_PANES` 에
  // 이 pane 을 넣으면서 축 칩을 껐다). 축 칩은 SSE 재투영을 따라 거의 실시간이고
  // 레전드 latest 는 캔들 epoch 주기라, 둘 다 켜면 같은 시리즈가 두 숫자로 보인다.
  it('가격축 최신값 칩과 기본 수평선을 끈다 (DESIGN.md 2026-05-23)', () => {
    const o = resolvedOptions();
    expect(o.lastValueVisible).toBe(false);
    expect(o.priceLineVisible).toBe(false);
  });

  it('draws a dotted, unlabelled price line at 0', () => {
    const createPriceLine = vi.fn();
    PROGRAM_TRADE_SPEC.series[0].afterAdd?.({ createPriceLine } as never);
    expect(createPriceLine).toHaveBeenCalledTimes(1);
    expect(createPriceLine.mock.calls[0][0]).toMatchObject({
      price: 0,
      lineWidth: 1,
      lineStyle: 1,
      axisLabelVisible: false,
      title: '',
    });
  });

  // net_amount 는 당일 누적이라 순매수만 이어진 구간을 확대하면 lwc 의 보이는-범위
  // 오토스케일이 0 을 배제한다 → 기준선이 pane 밖으로 나간다.
  it('keeps 0 inside a one-sided autoscale range', () => {
    const provider = resolvedOptions().autoscaleInfoProvider;
    expect(provider).toBeTypeOf('function');
    const res = provider!(() => ({
      priceRange: { minValue: 20_000_000_000, maxValue: 30_000_000_000 },
    }));
    expect(res?.priceRange).toEqual({ minValue: 0, maxValue: 30_000_000_000 });
  });

  it('keeps 0 inside a one-sided negative autoscale range', () => {
    const provider = resolvedOptions().autoscaleInfoProvider;
    const res = provider!(() => ({
      priceRange: { minValue: -30_000_000_000, maxValue: -20_000_000_000 },
    }));
    expect(res?.priceRange).toEqual({ minValue: -30_000_000_000, maxValue: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 세그먼트 조회를 `.find()` 선형 스캔에서 이진 탐색으로 바꿨다(O(N×S) → O(N log S)).
// **바꾼 부분이 유일 기여자**가 되게 조회 함수만 `.find()` 와 직접 대조한다 — 프로젝터
// 전체를 복제한 오라클보다 실패 지점을 정확히 가리킨다.
//
// 간극(장 마감~다음 개장)이 이 테스트의 핵심이다: `.find()` 는 undefined 를 주는데,
// "openMs <= t 인 마지막 세그먼트" 만 찾고 멈추는 이진 탐색은 **직전 세그먼트로 빨아들인다**.
// 상한 재확인(`t <= closeMs`)이 그걸 막고, 아래 간극 케이스가 그 확인의 red-check 이다.
describe('findSegmentIdxByTime == segments.find()', () => {
  const metas = [
    { openMs: 1000, closeMs: 2000, date: 'a', regularOpen: null, regularAuctionStart: 0 },
    { openMs: 5000, closeMs: 6000, date: 'b', regularOpen: null, regularAuctionStart: 0 },
    { openMs: 9000, closeMs: 9000, date: 'c', regularOpen: null, regularAuctionStart: 0 }, // 0폭 세그먼트
  ];
  const reference = (t: number): number =>
    metas.findIndex((s) => s.openMs <= t && t <= s.closeMs);

  const probes = [
    -1, 0, 999, 1000, 1001, 1999, 2000, // 첫 세그먼트: 앞·경계·안·끝(포함)
    2001, 3000, 4999,                   // 간극 → -1 이어야 한다
    5000, 5500, 6000, 6001,             // 둘째 세그먼트 + 그 뒤 간극
    8999, 9000, 9001,                   // 0폭 세그먼트와 그 뒤(축 끝 밖)
  ];

  it.each(probes)('t=%i 에서 같은 index', (t) => {
    expect(findSegmentIdxByTime(metas, t)).toBe(reference(t));
  });

  it('빈 세그먼트 배열은 -1', () => {
    expect(findSegmentIdxByTime([], 1234)).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 과거/당일 분리 캐시 == 풀 투영. `pastCachedProjector.test.ts` 의 관용구를 따른다 —
// 풀 투영 함수가 그대로 남아 있으므로 그것이 오라클이다.
//
// 픽스처가 **이틀**이어야 의미가 있다: 하루뿐이면 `segs.length < 2` 로 풀 투영에 위임해
// 캐시 경로를 아예 안 탄다. 그리고 날짜가 바뀌는 지점의 **경계 마스킹**(직전 방출점의
// 나가는 선을 투명으로)이 정확히 청크를 가로지르는 상태라, 그게 이 테스트의 표적이다.
describe('makeCachedProgramTradeProjector == 풀 투영', () => {
  const twoDayAxis = createVirtualAxis([
    { date: '20260512', sessionOpenMs: OPEN, sessionCloseMs: CLOSE },
    { date: '20260513', sessionOpenMs: NEXT_OPEN, sessionCloseMs: NEXT_CLOSE },
  ]);
  const mk = (extraToday: number[] = []): RangeBundle => {
    const day0 = [0, 1, 2, 3].map((m) => OPEN + m * 60_000);
    const day1 = [0, 1, 2, ...extraToday].map((m) => NEXT_OPEN + m * 60_000);
    const all = [...day0, ...day1];
    return {
      ...bundle(all.map((t, i) => ({ t, net_amount: (i + 1) * 1_000_000, net_qty: 0, gap_risk: false }))),
      segments: [
        { date: '20260512', session_open_ms: OPEN, session_close_ms: CLOSE },
        { date: '20260513', session_open_ms: NEXT_OPEN, session_close_ms: NEXT_CLOSE },
      ],
      quote_ratio: { bucket_ms: 60_000, points: all.map((t) => quotePoint(t)) },
    } as RangeBundle;
  };

  it('픽스처 전제: 두 거래일에 걸쳐 있고 날짜 경계 마스킹이 실제로 일어난다', () => {
    const out = projectProgramTradeNetAmount(mk(), twoDayAxis) as { color?: string }[];
    expect(out.length).toBeGreaterThan(4);
    // 경계에서 직전 점이 투명으로 덮였다 = 캐시가 과거 꼬리를 패치해야 하는 상황이다.
    expect(out.some((p) => p.color === HIDDEN_COLOR)).toBe(true);
  });

  it('캐시 첫 호출이 풀 투영과 같다', () => {
    const b = mk();
    expect(makeCachedProgramTradeProjector()(b, twoDayAxis))
      .toEqual(projectProgramTradeNetAmount(b, twoDayAxis));
  });

  it('당일이 늘어난 뒤(= SSE 틱)에도 풀 투영과 같다 — 과거 캐시 적중 경로', () => {
    const cached = makeCachedProgramTradeProjector();
    const first = mk();
    cached(first, twoDayAxis); // 과거를 캐시에 올린다
    for (const extra of [[3], [3, 4], [3, 4, 5]]) {
      const next = mk(extra);
      expect(cached(next, twoDayAxis)).toEqual(projectProgramTradeNetAmount(next, twoDayAxis));
    }
  });

  it('program_trade 가 비면 호가점이 있어도 빈 배열', () => {
    const b = { ...mk(), program_trade: { points: [] } } as RangeBundle;
    expect(makeCachedProgramTradeProjector()(b, twoDayAxis)).toEqual([]);
  });

  it('날짜 필터·실시간 병합 후에도 과거 축 투영을 반복하지 않는다', () => {
    const cached = makeCachedProgramTradeProjector();
    const first = mk([3]);
    const candles = [OPEN, NEXT_OPEN].map(ts_ms => ({ ts_ms, open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 1 }));
    const persisted = filterProgramTradeForCandles(first.program_trade, candles);
    const spy = vi.fn((t: number) => twoDayAxis.classifyAndProject(t));
    const measuredAxis = { ...twoDayAxis, classifyAndProject: spy };
    cached({ ...first, program_trade: mergeProgramTradeSeriesWithLiveTail(persisted, []) }, measuredAxis);
    try {
      for (const amount of [100, -200, 300]) {
        // 캔들 가격만 바뀌어도 같은 날짜의 프로그램 원소는 재사용되어야 한다.
        const filtered = filterProgramTradeForCandles(first.program_trade, candles.map(c => ({ ...c, close: amount })));
        expect(filtered.points).toBe(persisted.points);
        const next = { ...first, program_trade: mergeProgramTradeSeriesWithLiveTail(filtered, [
          { t_ms: NEXT_OPEN + 3 * 60_000 + 1000, net_amount: amount },
        ]) };
        spy.mockClear();
        const actual = cached(next, measuredAxis);
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls.every(([t]) => t >= NEXT_OPEN)).toBe(true);
        expect(actual).toEqual(projectProgramTradeNetAmount(next, twoDayAxis));
        expect(actual.at(-1)?.value).toBe(amount);
      }
    } finally { spy.mockRestore(); }
  });

  it('과거 중간 프로그램 값과 호가 결손 표시의 정정은 캐시를 무효화한다', () => {
    const cached = makeCachedProgramTradeProjector();
    const first = mk();
    const original = cached(first, twoDayAxis);
    const corrected = { ...first, program_trade: { ...first.program_trade,
      points: first.program_trade!.points.map((p, i) => i === 1 ? { ...p, net_amount: -999 } : p),
    } };
    const changed = cached(corrected, twoDayAxis);
    expect(changed).toEqual(projectProgramTradeNetAmount(corrected, twoDayAxis));
    expect(changed).not.toEqual(original);
    const gap = { ...corrected, quote_ratio: { ...corrected.quote_ratio,
      points: corrected.quote_ratio.points.map((p, i) => i === 1 ? quotePoint(p.t, true) : p),
    } };
    const gapData = cached(gap, twoDayAxis);
    expect(gapData).toEqual(projectProgramTradeNetAmount(gap, twoDayAxis));
    expect(gapData).not.toEqual(changed);
    expect(cached(first, twoDayAxis)).toEqual(original);
  });

  it('같은 axis에서 종목·봉·세그먼트·이력 범위가 바뀌어도 풀 투영과 같다', () => {
    const cached = makeCachedProgramTradeProjector();
    const first = mk();
    cached(first, twoDayAxis);
    const variants = [
      { ...first, code: '000660' },
      { ...first, bucket_ms: 120_000 },
      { ...first, segments: first.segments.map(s => ({ ...s })) },
      { ...first, program_trade: { ...first.program_trade, points: first.program_trade!.points.slice(1) } },
      { ...first, quote_ratio: { ...first.quote_ratio, points: first.quote_ratio.points.slice(1) } },
      { ...first, program_trade: { points: [...first.program_trade!.points].reverse() } },
      first,
    ];
    for (const next of variants) expect(cached(next, twoDayAxis)).toEqual(projectProgramTradeNetAmount(next, twoDayAxis));
  });
});

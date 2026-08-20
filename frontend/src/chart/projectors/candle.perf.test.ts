// @vitest-environment node
//
// **벽시계가 아니라 축 호출 횟수로 주장한다.**
//
// 이전 판은 `expect(fused).toBeLessThanOrEqual(legacy * 1.2)` 로 두 경로의 실행 시간을
// 비교했다. 공유 러너에서 그 비율은 노이즈다 — 2026-07-30 CI 에서 23.02 vs 22.30(=1.03배)
// 으로 **1.2배 예산 안인데도** 실패했다. `frontend` 잡은 차단 게이트라 그런 flake 가 머지를
// 막는다. 이 저장소는 이미 PR #516 에서 같은 이유로 프론트 성능 테스트를 결정론적 성질로
// 바꾼 선례가 있다.
//
// 지키려는 성질은 "빠르다" 가 아니라 **"캔들당 축을 한 번만 두드린다"** 이다.
// `VirtualAxis.classifyAndProject` 의 docstring 이 그 계약을 이미 말한다 —
// 한 번의 이진 탐색으로 `contains` / `inClosingAuctionWindow` / `toVirtual` 셋을 모두 얻는다.
// 레거시 3-콜 경로를 같은 계수기로 재면 3N 이 나오므로 이 테스트는 **자기 안에 대조군을
// 갖는다**: 느려서 실패하는 게 아니라, 한 번이 아니면 실패한다.
import { describe, it, expect } from 'vitest';
import { projectCandle } from './candle';
import { projectBidPoints, projectAskPoints } from './quoteTotals';
import { projectRatioPoints } from './ratio';
import { projectBuyPoints, projectSellPoints, projectCumulativeSegment } from './fillStrength';
import { projectProgramTradeNetAmount } from './programTrade';
import { createVirtualAxis } from '../../util/virtualAxis';

/** 축 메서드 호출을 세는 위임 래퍼. 반환값은 원본 그대로라 동작에 영향이 없다.
 *
 *  Proxy 를 쓸 수 없다 — `createVirtualAxis` 결과는 **freeze** 돼 있어서, get 트랩이
 *  원본과 다른 값을 돌려주면 프록시 불변식 위반으로 TypeError 가 난다
 *  ("read-only and non-configurable data property"). 평범한 객체로 복사해 감싼다. */
function countingAxis<T extends object>(target: T): { axis: T; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const axis: Record<string, unknown> = {};
  for (const key of Object.keys(target)) {
    const value = (target as Record<string, unknown>)[key];
    if (typeof value !== 'function') {
      axis[key] = value;
      continue;
    }
    axis[key] = (...args: unknown[]) => {
      calls[key] = (calls[key] ?? 0) + 1;
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  }
  return { axis: axis as T, calls };
}

// 레거시 3-콜 경로를 재현한 레퍼런스 projector — **대조군**이다.
// pre-Task-2 경로 그대로: filter→map, 3개 axis 호출, color 계산, 8필드.
// 실제 토큰 색은 candle.ts에 module-private이라, 같은 작업량 재현 목적의 로컬 상수.
function projectCandleLegacy(bundle: any, axis: any) {
  const up = 'up', down = 'down', muted = 'muted';
  return bundle.candles
    .filter((c: any) => axis.contains(c.ts_ms))
    .map((c: any) => {
      const inAuction = axis.inClosingAuctionWindow(c.ts_ms);
      const color = inAuction ? muted : c.close >= c.open ? up : down;
      return {
        time: axis.toVirtual(c.ts_ms) / 1000,
        open: c.open,
        close: c.close,
        high: c.high,
        low: c.low,
        color,
        borderColor: color,
        wickColor: color,
      };
    });
}

describe('projectCandle single-pass 계약', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const FULL = 6.5 * 60 * 60 * 1000;
  const base = 1_779_062_400_000;
  // 호출 횟수는 N 에 선형이라 큰 N 이 더 잡아주는 게 없다 — 이전 판의 65k 캔들(170일)은
  // 벽시계 측정용이었다. 2일 × 390분봉이면 계약이 그대로 드러난다.
  const DAYS = 2;
  const PER_DAY = 390;

  const segments = [];
  for (let d = 0; d < DAYS; d++) {
    const open = base + d * DAY;
    segments.push({ date: `2026d${d}`, sessionOpenMs: open, sessionCloseMs: open + FULL });
  }
  const axis = createVirtualAxis(segments);

  const candles = [];
  for (let d = 0; d < DAYS; d++) {
    const open = base + d * DAY;
    for (let m = 0; m < PER_DAY; m++) {
      candles.push({ ts_ms: open + m * 60_000, open: 100, close: 101, high: 102, low: 99 });
    }
  }
  const bundle: any = { candles };
  const N = candles.length;

  const AXIS_METHODS = ['classifyAndProject', 'contains', 'inClosingAuctionWindow', 'toVirtual'] as const;
  const totalAxisCalls = (calls: Record<string, number>) =>
    AXIS_METHODS.reduce((sum, m) => sum + (calls[m] ?? 0), 0);

  it('캔들당 축을 정확히 한 번 두드린다 (classifyAndProject)', () => {
    const { axis: counted, calls } = countingAxis(axis);
    projectCandle(bundle, counted);

    expect(calls.classifyAndProject).toBe(N);
    // 셋을 따로 부르면 이진 탐색이 3배가 된다 — 그게 이 최적화가 없앤 것이다.
    expect(calls.contains ?? 0).toBe(0);
    expect(calls.inClosingAuctionWindow ?? 0).toBe(0);
    expect(calls.toVirtual ?? 0).toBe(0);
    expect(totalAxisCalls(calls)).toBe(N);
  });

  it('대조군: 레거시 3-콜 경로는 캔들당 3번 두드린다', () => {
    const { axis: counted, calls } = countingAxis(axis);
    projectCandleLegacy(bundle, counted);

    // 이 대조군이 있어야 위 단언이 "숫자가 우연히 맞은 것" 이 아님을 보인다.
    expect(totalAxisCalls(calls)).toBe(3 * N);
    expect(calls.classifyAndProject ?? 0).toBe(0);
  });

  it('두 경로의 결과가 같다 — 적게 부른 게 덜 한 것이 아니다', () => {
    const fused = projectCandle(bundle, axis);
    const legacy = projectCandleLegacy(bundle, axis);

    expect(fused.length).toBe(legacy.length);
    // 색 토큰은 구현이 module-private 이라 값이 다르다 — 숫자 필드만 비교한다.
    expect(fused.map((c: any) => [c.time, c.open, c.close, c.high, c.low]))
      .toEqual(legacy.map((c: any) => [c.time, c.open, c.close, c.high, c.low]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 같은 계약을 **호가 pane 프로젝터 전부**로 넓힌다(2026-08-20). 종전엔 이들이 점마다
// `contains` + `toVirtual` (+ 마스크 경로에서 `inClosingAuctionWindow`)를 따로 불러
// 점당 이진 탐색이 2~3회였다 — 90일 35,100점 실측 4.34ms → 1.66ms 였던 지점이다.
//
// 벽시계가 아니라 **호출 횟수**로 주장하는 이유는 위 캔들 계약과 같다: 공유 러너에서
// 시간 비율은 노이즈이고, 지키려는 성질은 "빠르다" 가 아니라 "점당 한 번" 이다.
// 대조군은 캔들 쪽처럼 별도 레거시 구현을 두지 않는다 — `contains`/`toVirtual` 이
// **0 이어야 한다**는 단언 자체가 대조군 역할을 한다(옛 경로면 그 둘이 N 이 된다).
describe('호가 pane 프로젝터 single-pass 계약', () => {
  const FULL = 6.5 * 60 * 60 * 1000;
  const DAYS = 2;
  const PER_DAY = 30;

  const segments: { date: string; sessionOpenMs: number; sessionCloseMs: number }[] = [];
  const bundleSegments: { date: string; session_open_ms: number; session_close_ms: number }[] = [];
  // ⚠ `date` 는 **`session_open_ms` 와 실제로 일치해야 한다.** 프로그램 순매수는
  // `regularSessionBoundsForDate(date)`(= `Date.UTC(y, m-1, d)`)로 정규장 창을 만들고
  // 그 밖의 점을 버린다 — 지어낸 날짜('2026060N' 같은)를 쓰면 창이 엉뚱한 곳에 생겨
  // **모든 program_trade 점이 조용히 걸러지고**, 그러면 `byBucket` 이 비어 방출 경로가
  // 사실상 테스트되지 않는다(그 상태에서도 `classifyAndProject` 계수는 N 이라 초록이다).
  const yyyymmdd = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
  for (let d = 0; d < DAYS; d++) {
    const open = Date.UTC(2026, 5, 22 + d, 0, 0, 0); // 09:00 KST = 그 날짜의 UTC 자정
    segments.push({ date: yyyymmdd(open), sessionOpenMs: open, sessionCloseMs: open + FULL });
    bundleSegments.push({ date: yyyymmdd(open), session_open_ms: open, session_close_ms: open + FULL });
  }
  const axis = createVirtualAxis(segments);

  const quotePoints: Record<string, number>[] = [];
  const fillPoints: Record<string, number>[] = [];
  const programPoints: Record<string, number>[] = [];
  for (let d = 0; d < DAYS; d++) {
    const open = bundleSegments[d].session_open_ms;
    for (let m = 0; m < PER_DAY; m++) {
      const t = open + m * 60_000;
      quotePoints.push({
        t, bid_total: 100 + m, ask_total: 120 + m, bid_max: 130, ask_max: 140,
        imb_max_bid: 100, imb_max_ask: 120, band_pct: 1, tick: 10,
      });
      fillPoints.push({ t, buy_qty: m, sell_qty: m + 1 });
      programPoints.push({ t, net_amount: (m + 1) * 1_000 });
    }
  }
  const N = quotePoints.length;
  const bundle: any = {
    code: '005930', bucket_ms: 60_000, segments: bundleSegments, candles: [],
    quote_ratio: { bucket_ms: 60_000, points: quotePoints },
    fill_strength: { bucket_ms: 60_000, points: fillPoints },
    program_trade: { points: programPoints },
  };

  const AXIS_METHODS = ['classifyAndProject', 'contains', 'inClosingAuctionWindow', 'toVirtual'] as const;
  const totalAxisCalls = (calls: Record<string, number>) =>
    AXIS_METHODS.reduce((sum, m) => sum + (calls[m] ?? 0), 0);

  /** 점당 축 조회가 정확히 1회인지 — `classifyAndProject` 만 N 번, 나머지 셋은 0. */
  const expectOnePerPoint = (calls: Record<string, number>, n: number): void => {
    expect(calls.classifyAndProject).toBe(n);
    expect(calls.contains ?? 0).toBe(0);
    expect(calls.toVirtual ?? 0).toBe(0);
    expect(calls.inClosingAuctionWindow ?? 0).toBe(0);
    expect(totalAxisCalls(calls)).toBe(n);
  };

  it.each([
    ['총잔량 매수', (b: any, a: any) => projectBidPoints(b.quote_ratio.points, a, true)],
    ['총잔량 매도', (b: any, a: any) => projectAskPoints(b.quote_ratio.points, a, true)],
    ['체결강도 매수', (b: any, a: any) => projectBuyPoints(b.fill_strength.points, a, true)],
    ['체결강도 매도', (b: any, a: any) => projectSellPoints(b.fill_strength.points, a, true)],
  ])('%s — 점당 축 1회', (_label, run) => {
    const { axis: counted, calls } = countingAxis(axis);
    run(bundle, counted);
    expectOnePerPoint(calls, N);
  });

  it('호가비 — 점당 축 1회', () => {
    const { axis: counted, calls } = countingAxis(axis);
    projectRatioPoints(bundle.quote_ratio.points, counted, {
      auctionWindowMask: true, outlierFilterEnabled: false, outlierThreshold: 100, intraMax: false,
    } as any);
    expectOnePerPoint(calls, N);
  });

  it('픽스처 전제: 프로그램 순매수가 실제로 점을 방출한다', () => {
    // 위 `date`↔`session_open_ms` 정합이 깨지면 여기서 0 이 되어, 아래 계수 계약이
    // "아무것도 안 하는 코드" 를 재고 있음을 알려 준다.
    expect(projectProgramTradeNetAmount(bundle, axis).length).toBeGreaterThan(0);
  });

  it('프로그램 순매수 — 축 조회는 점당 1회 (program_trade 는 축을 세그먼트로만 쓴다)', () => {
    const { axis: counted, calls } = countingAxis(axis);
    projectProgramTradeNetAmount(bundle, counted);
    // byBucket 을 세울 때 program_trade 점마다 `contains` 를 한 번 부르고(그쪽은 버킷
    // 시각의 포함 여부만 필요하다), 방출 루프에서 호가점마다 `classifyAndProject` 1회.
    expect(calls.classifyAndProject).toBe(N);
    // `contains` 도 **정확히** 박는다 — `toBe(0)` 이 아니라 `toBe(N)` 인 이유가 위 한 줄이다.
    // 안 박아 두면 방출 루프에 점당 `contains` 가 되살아나도 이 테스트가 통과한다
    // (`classifyAndProject` 는 여전히 N 이므로). 픽스처의 program_trade 점 수가 호가점과
    // 같아 둘 다 N 이다.
    expect(calls.contains ?? 0).toBe(N);
    expect(calls.toVirtual ?? 0).toBe(0);
    expect(calls.inClosingAuctionWindow ?? 0).toBe(0);
  });

  it('누적 체결강도 — 세그먼트 안 점당 축 1회', () => {
    const { axis: counted, calls } = countingAxis(axis);
    projectCumulativeSegment(bundleSegments[0] as any, 0, fillPoints as any, counted, true, 60_000, true);
    // 세그먼트 0 의 점만 방출 대상 — 나머지는 경계 검사에서 걸러 축을 안 두드린다.
    expect(calls.classifyAndProject).toBe(PER_DAY);
    // 남은 `contains`/`toVirtual` 은 **세그먼트당 1회**(0 앵커를 놓을 자리인지 보는
    // `seg.session_open_ms` 검사)라 점 수와 무관하다 — 점당 비용이 아니다.
    expect(calls.contains ?? 0).toBeLessThanOrEqual(1);
    expect(calls.toVirtual ?? 0).toBeLessThanOrEqual(1);
    expect(calls.inClosingAuctionWindow ?? 0).toBe(0);
  });
});

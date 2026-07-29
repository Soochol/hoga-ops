/**
 * 슬라이딩(앞이 잘리는) 버퍼 아래에서의 증분 버킷터 패리티.
 *
 * 15분 버퍼는 앞에서 `splice` 로 축출한다. 그러면 증분 누적 상태에는 **이미 사라진
 * 스냅샷의 기여**가 남는다 — 특히 버킷별 `bid_max`/`ask_max` 는 러닝 맥스라, 피크
 * 틱이 축출되면 오라클(현재 배열만 봄)의 값은 내려가는데 누적본은 그대로다.
 * 그래서 이 시나리오의 정답은 "인덱스 보정"이 아니라 "밀려난 버킷 폐기 + 부분
 * 축출된 선두 버킷 재계산"이고, 아래가 그 계약을 고정한다.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildHogaSeries, createIncrementalHogaSeriesBuilder } from './buildLiveBundle';
import * as bucketMod from './bucketHogaSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const OPEN = Date.UTC(2026, 6, 29, 0, 0, 0);
const CLOSE = OPEN + 6.5 * 3600_000;
const BUCKET = 60_000;
const RETENTION = 15 * 60_000;

function lvls(qty: number, auction: boolean) {
  return Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty: auction && i >= 3 ? 0 : qty }));
}

/** 결정론적 의사난수 — Math.random 금지(재현 가능해야 한다). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function makeSeries(seed: number, n: number, stepMs: number) {
  const r = rng(seed);
  const ob: ObSnapshot[] = [];
  const trade: TradeSnapshot[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = OPEN + i * stepMs;
    const auction = r() < 0.08;
    // 피크가 앞쪽에 몰리도록 — 축출로 max 가 내려가는 상황을 실제로 만든다.
    const spike = r() < 0.15 ? 5_000 : 0;
    const ask = 100 + Math.floor(r() * 50) + spike;
    const bid = 90 + Math.floor(r() * 50) + spike;
    ob.push({ t_ms: t, total_ask_qty: ask, total_bid_qty: bid, asks: lvls(ask, auction), bids: lvls(bid, auction) });
    if (r() < 0.6) {
      trade.push({ t_ms: t, trades: [{ side: r() < 0.5 ? 1 : -1, qty: 1 + Math.floor(r() * 20) }] });
    }
  }
  return { ob, trade };
}

/** 15분 보존 창을 적용한다 — liveSnapshotBuffer.evictOld 와 같은 규칙. */
function windowed<T extends { t_ms: number }>(arr: readonly T[], nowMs: number): T[] {
  const cutoff = nowMs - RETENTION;
  return arr.filter((s) => s.t_ms >= cutoff);
}

describe('증분 버킷터 — 슬라이딩 버퍼 패리티', () => {
  const base = { todaySession: { open_ms: OPEN, close_ms: CLOSE }, pastBundle: null, bucketMs: BUCKET };

  for (const [seed, flags] of [
    [1, { depthHeatmapEnabled: false, depthDeltaEnabled: false }],
    [2, { depthHeatmapEnabled: true, depthDeltaEnabled: true }],
    [3, { depthHeatmapEnabled: true, depthDeltaEnabled: false }],
    [4, { depthHeatmapEnabled: false, depthDeltaEnabled: true }],
  ] as const) {
    it(`seed=${seed} · 축출이 진행되는 동안 매 스텝 오라클과 일치한다 (${JSON.stringify(flags)})`, () => {
      // 25분치 = 15분 보존 창을 확실히 넘겨 축출이 오래 지속되게 한다.
      const stepMs = 2_000;
      const { ob, trade } = makeSeries(seed, (25 * 60_000) / stepMs, stepMs);
      const build = createIncrementalHogaSeriesBuilder();

      for (let i = 1; i <= ob.length; i += 1) {
        const nowMs = ob[i - 1].t_ms;
        const input = {
          ...base, ...flags,
          sseOb: windowed(ob.slice(0, i), nowMs),
          sseTrade: windowed(trade.filter((s) => s.t_ms <= nowMs), nowMs),
        };
        expect(build(input)).toEqual(buildHogaSeries(input));
      }
    });
  }

  it('버킷 앞부분이 축출되면 러닝 맥스가 오라클처럼 내려간다', () => {
    // 이 단언이 "인덱스만 보정" 구현을 직접 반증한다 — 그런 구현은 5000 을 계속 든다.
    const spike: ObSnapshot = {
      t_ms: OPEN, total_ask_qty: 5_000, total_bid_qty: 4_000,
      asks: lvls(5_000, false), bids: lvls(4_000, false),
    };
    const calm = [10_000, 20_000].map((d): ObSnapshot => ({
      t_ms: OPEN + d, total_ask_qty: 120, total_bid_qty: 80,
      asks: lvls(120, false), bids: lvls(80, false),
    }));
    const build = createIncrementalHogaSeriesBuilder();

    build({ ...base, sseOb: [spike, ...calm], sseTrade: [] });
    const after = build({ ...base, sseOb: calm, sseTrade: [] });

    expect(after.quote_ratio.points[0].ask_max).toBe(120);
    expect(after).toEqual(buildHogaSeries({ ...base, sseOb: calm, sseTrade: [] }));
  });

  /**
   * 성능 가드 — 벽시계가 아니라 **호출 횟수**로 잰다(벽시계 단언은 full-suite 워커
   * 경합에 flaky). `isContinuousBook` 은 appendOb 가 넘겨받은 배치의 스냅샷마다 정확히
   * 한 번 불린다. 통짜 재빌드면 창 전체(수천 건)에, 증분이면 델타 + 선두 버킷 하나에만
   * 불린다 — 그 차이가 이 최적화의 정의 그 자체다.
   */
  it('축출이 진행돼도 창 전체를 다시 훑지 않는다', () => {
    const stepMs = 2_000;
    const { ob, trade } = makeSeries(9, (25 * 60_000) / stepMs, stepMs);
    const build = createIncrementalHogaSeriesBuilder();
    const input = (i: number) => {
      const nowMs = ob[i - 1].t_ms;
      return {
        ...base,
        depthHeatmapEnabled: true,
        depthDeltaEnabled: true,
        sseOb: windowed(ob.slice(0, i), nowMs),
        sseTrade: windowed(trade.filter((s) => s.t_ms <= nowMs), nowMs),
      };
    };
    // 창이 꽉 차고 축출이 한동안 진행된 상태까지 워밍업.
    for (let i = 1; i <= ob.length - 1; i += 1) build(input(i));

    const warm = input(ob.length);
    const spy = vi.spyOn(bucketMod, 'isContinuousBook');
    try {
      build(warm);
      // 델타 1건 + 선두 버킷 하나(2초 간격 × 60초 = 30건) 수준이어야 한다. 통짜
      // 재빌드면 창 전체(450건)를 훑으므로 그 1/4 을 넘기면 회귀로 본다.
      expect(spy.mock.calls.length).toBeLessThan(warm.sseOb.length / 4);
    } finally {
      spy.mockRestore();
    }
  });
});

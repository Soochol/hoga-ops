import { describe, expect, it, vi } from 'vitest';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
import * as bucketHogaSeries from './bucketHogaSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const base = Date.UTC(2026, 5, 23, 0, 0, 0); // 09:00 KST → isAfterRegularOpen 통과

function mkOb(i: number): ObSnapshot {
  return {
    t_ms: base + i * 1000,
    total_ask_qty: 1000 + i,
    total_bid_qty: 900 + i,
    // 10레벨 연속북(index 3+ qty>0) → isContinuousBook 통과 → consumeOb가 소비.
    asks: Array.from({ length: 10 }, (_unused, level) => ({ price: 40_000 + level, qty: 100 + i + level })),
    bids: Array.from({ length: 10 }, (_unused, level) => ({ price: 40_000 + level, qty: 120 + i + level })),
  };
}

function mkTrade(i: number): TradeSnapshot {
  return { t_ms: base + i * 1000, trades: [{ side: i % 2 === 0 ? 1 : -1, price: 40_000 + (i % 10), qty: 1 }] };
}

// 원래 이 파일은 `expect(elapsed).toBeLessThan(500)` 벽시계 단언이었으나 full-suite
// 워커 경합에 flaky했다(issue #434). 성능을 담보하는 실제 불변식 — IncrementalPeak
// WallSource가 append-only 갱신에서 델타만 소비하고 버퍼 전체를 재스캔하지 않는 것 —
// 을 결정론적 호출횟수로 검증한다(sibling useVolumeDistributionCutoffProfile.test와
// 동일 정신). isIndicatorEligibleBook(공용 유효-스냅샷 술어)은 소비되는 ob 스냅샷당
// consumeOb 루프에서 정확히 1회 호출되고 classify는 호출하지 않으므로, 그 호출 수 =
// 소비된 스냅샷 수의 결정론적 프록시다. 전체 재스캔(O(n²)) 회귀면 append 갱신이 델타
// 1이 아니라 전체를 다시 센다.
describe('live day peak performance (incremental, deterministic)', () => {
  it('appended ob snapshots consume the delta only, not a full re-scan', () => {
    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    const src = new IncrementalPeakWallSource('ask');
    const ob: ObSnapshot[] = Array.from({ length: 2000 }, (_unused, i) => mkOb(i));

    src.update(ob, [], []);
    const afterFull = spy.mock.calls.length;
    expect(afterFull).toBe(2000); // 첫 소비 = 전체 1회 패스(스냅샷당 1회)

    // prefix 참조가 그대로인 append-only 갱신(+1 스냅샷).
    src.update([...ob, mkOb(2000)], [], []);
    expect(spy.mock.calls.length - afterFull).toBe(1); // 델타 1개만 소비

    spy.mockRestore();
  });

  it('a replaced buffer falls back to a full re-consume (correctness safety net)', () => {
    // 폴백 경로(prefix 참조 불일치)는 전체를 다시 소비해야 정확성이 유지된다 —
    // 증분 최적화가 이 안전망을 없애지 않았는지 확인한다.
    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    const src = new IncrementalPeakWallSource('bid');
    const ob: ObSnapshot[] = Array.from({ length: 500 }, (_unused, i) => mkOb(i));
    src.update(ob, [], []);
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBe(500);

    // 새 배열(참조 불일치) → reset 후 전체 재소비.
    const replaced: ObSnapshot[] = Array.from({ length: 500 }, (_unused, i) => mkOb(i));
    src.update(replaced, [], []);
    expect(spy.mock.calls.length - afterFirst).toBe(500);

    spy.mockRestore();
  });

  it('produces the same classification as a from-scratch source (incremental == batch)', () => {
    // 증분 소스가 append로 누적한 결과 == 콜드 소스가 전체를 한 번에 받은 결과.
    const ob: ObSnapshot[] = Array.from({ length: 300 }, (_unused, i) => mkOb(i));
    const trade: TradeSnapshot[] = Array.from({ length: 300 }, (_unused, i) => mkTrade(i));

    const incremental = new IncrementalPeakWallSource('ask');
    for (let n = 1; n <= ob.length; n += 50) {
      incremental.update(ob.slice(0, n), trade.slice(0, n), []);
    }
    const incrementalResult = incremental.update(ob, trade, []);

    const cold = new IncrementalPeakWallSource('ask');
    const coldResult = cold.update(ob, trade, []);

    expect(incrementalResult).toEqual(coldResult);
  });
});

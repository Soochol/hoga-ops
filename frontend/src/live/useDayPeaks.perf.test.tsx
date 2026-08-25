import { describe, expect, it, vi } from 'vitest';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
import * as bucketHogaSeries from './bucketHogaSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const base = Date.UTC(2026, 5, 23, 0, 0, 0); // 09:00 KST
// 개장 하한 — 필수 인자화 경위는 computeDayAskPeak.test 의 같은 상수 참조.
const OPEN_MS = base;

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

    src.update(ob, [], OPEN_MS, []);
    const afterFull = spy.mock.calls.length;
    expect(afterFull).toBe(2000); // 첫 소비 = 전체 1회 패스(스냅샷당 1회)

    // prefix 참조가 그대로인 append-only 갱신(+1 스냅샷).
    src.update([...ob, mkOb(2000)], [], OPEN_MS, []);
    expect(spy.mock.calls.length - afterFull).toBe(1); // 델타 1개만 소비

    spy.mockRestore();
  });

  it('a replaced buffer falls back to a full re-consume (correctness safety net)', () => {
    // 폴백 경로(prefix 참조 불일치)는 전체를 다시 소비해야 정확성이 유지된다 —
    // 증분 최적화가 이 안전망을 없애지 않았는지 확인한다.
    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    const src = new IncrementalPeakWallSource('bid');
    const ob: ObSnapshot[] = Array.from({ length: 500 }, (_unused, i) => mkOb(i));
    src.update(ob, [], OPEN_MS, []);
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBe(500);

    // 새 배열(참조 불일치) → reset 후 전체 재소비.
    const replaced: ObSnapshot[] = Array.from({ length: 500 }, (_unused, i) => mkOb(i));
    src.update(replaced, [], OPEN_MS, []);
    expect(spy.mock.calls.length - afterFirst).toBe(500);

    spy.mockRestore();
  });


  it('produces the same classification as a from-scratch source (incremental == batch)', () => {
    // 증분 소스가 append로 누적한 결과 == 콜드 소스가 전체를 한 번에 받은 결과.
    const ob: ObSnapshot[] = Array.from({ length: 300 }, (_unused, i) => mkOb(i));
    const trade: TradeSnapshot[] = Array.from({ length: 300 }, (_unused, i) => mkTrade(i));

    const incremental = new IncrementalPeakWallSource('ask');
    for (let n = 1; n <= ob.length; n += 50) {
      incremental.update(ob.slice(0, n), trade.slice(0, n), OPEN_MS, []);
    }
    const incrementalResult = incremental.update(ob, trade, OPEN_MS, []);

    const cold = new IncrementalPeakWallSource('ask');
    const coldResult = cold.update(ob, trade, OPEN_MS, []);

    expect(incrementalResult).toEqual(coldResult);
  });

  // venue 전환(KRX 09:00 ↔ NXT 08:00). 인스턴스는 훅 수명 내내 useRef 로 고정되므로
  // 전환을 인스턴스 교체로 표현할 수 없다 — accumulate 가 하한 변경을 보고 누적을 버려야
  // 한다. 안 버리면 이전 하한으로 걸러진 벽 집합이 그대로 남는다.
  it('개장 하한이 바뀌면 누적을 버리고 콜드 소스와 같아진다 (venue 전환)', () => {
    const preOpenMs = base - 30 * 60_000; // 이 하한이면 아래 스냅샷이 전부 유효
    const ob: ObSnapshot[] = Array.from({ length: 40 }, (_unused, i) => mkOb(i));
    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');

    const src = new IncrementalPeakWallSource('ask');
    src.update(ob, [], OPEN_MS, []);
    const afterWarm = spy.mock.calls.length;

    // 하한만 바뀐 같은 입력 — 델타가 없어도 전량 재소비되어야 한다.
    const switched = src.update(ob, [], preOpenMs, []);
    expect(spy.mock.calls.length - afterWarm).toBe(ob.length);
    spy.mockRestore();

    const cold = new IncrementalPeakWallSource('ask');
    expect(switched).toEqual(cold.update(ob, [], preOpenMs, []));
  });
});

/**
 * 슬라이딩 축출(15분 창)에서도 **델타만 소비**한다 — 트랙 1-3.
 *
 * 위 두 테스트는 배열이 **append-only** 이거나 **통째로 교체**되는 두 경우만 본다.
 * 실제 라이브 버퍼는 세 번째 모양을 만든다 — **앞을 자르고 뒤에 붙인다**(15분 슬라이딩).
 * 종전 prefix-guard(`ob[L-1] === lastRef`)는 그 모양에서 **항상 실패**해 매 flush 마다
 * 전량 재소비가 일어났다. 기존 테스트가 이 축을 **원리적으로 못 보는 것**이 결함이 숨은
 * 이유였고, 그래서 이 케이스가 여기 있다.
 *
 * ## 무엇이 어려웠나 (고칠 때 읽을 것)
 *
 * `locate()` 만 이식하면 **오히려 나빠진다**. `classify()` 는 매 호출 누적 이벤트를 전량
 * 순회하고 `events` 에는 `reset()` 말고 가지치기 경로가 없었다 — 가드만 관대하게 만들면
 * ① 이벤트가 세션 내내 단조 증가하고 ② 창 밖으로 밀려난 벽이 남아 배치 오라클과 갈린다
 * (#926 이 형제에서 실측한 "오라클 ask_max 는 5000→120 인데 누적본은 5000" 과 같은 실패).
 *
 * 그래서 슬라이딩과 **축출을 같이** 넣었다: `eventSeq`(스냅샷 순번) 기준 prefix 절단 +
 * `head` 포인터(맵 재구축 회피, 절반 넘으면 압축) + trade 스냅샷별 터치 기여 개수로 정확
 * 환산. t_ms 중복·터치 역순은 **sticky 플래그로 잡아 전량 재소비로 폴백**한다 — 정확성은
 * 언제나 폴백이 보증하고, 증분은 "같은 결과를 덜 계산" 하는 수단일 뿐이다.
 *
 * 실측(2026-08-17, 이 파일과 같은 픽스처, 축출 정상상태 flush 1회):
 *   n=900 1.90ms · 4,500 10.81ms · 9,000 24.20ms · 18,000 63.78ms  (재소비가 89~92%)
 * 수정 후에는 append 경로와 같은 수준으로 떨어진다.
 */
describe('live day peak — 슬라이딩 축출도 델타만 소비한다', () => {
  it('앞을 자르고 뒤에 붙여도 새 스냅샷만 소비한다', () => {
    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    const src = new IncrementalPeakWallSource('ask');
    const ob: ObSnapshot[] = Array.from({ length: 2000 }, (_unused, i) => mkOb(i));

    src.update(ob, [], OPEN_MS, []);
    const afterFull = spy.mock.calls.length;
    expect(afterFull).toBe(2000);

    // ⚠ 새 스냅샷은 **한 번만 만들어 재사용**한다 — prefix-guard 는 참조 동일성으로
    // 판정하므로, 같은 인덱스로 mkOb 를 다시 부르면 다른 객체가 되어 폴백이 뜬다
    // (라이브 버퍼는 객체를 유지하므로 그게 실제 모양이 아니다).
    const fresh = Array.from({ length: 4 }, (_unused, i) => mkOb(2000 + i));

    // 슬라이딩 창: 앞 1개를 버리고 뒤 1개를 붙인다(라이브 버퍼의 실제 모양).
    const win1 = [...ob.slice(1), fresh[0]];
    src.update(win1, [], OPEN_MS, []);
    expect(spy.mock.calls.length - afterFull).toBe(1);

    // 여러 개를 한 번에 밀어도 붙인 만큼만 — 실전에서 flush 사이에 여러 틱이 온다.
    const before = spy.mock.calls.length;
    src.update([...win1.slice(3), fresh[1], fresh[2], fresh[3]], [], OPEN_MS, []);
    expect(spy.mock.calls.length - before).toBe(3);

    spy.mockRestore();
  });

  it('축출된 벽은 결과에서 사라진다 — 메모리 상한과 정확성이 같은 수정에 달려 있다', () => {
    // 창 안에서 압도적으로 큰 벽을 하나 세우고, 그 스냅샷을 창 밖으로 밀어낸다.
    const huge = mkOb(0);
    huge.asks = [
      ...Array.from({ length: 9 }, (_u, l) => ({ price: 40_000 + l, qty: 1 })),
      { price: 49_999, qty: 999_999 },
    ];
    const rest = Array.from({ length: 20 }, (_unused, i) => mkOb(i + 1));
    const src = new IncrementalPeakWallSource('ask');
    src.update([huge, ...rest], [], OPEN_MS, []);
    expect(src.update([huge, ...rest], [], OPEN_MS, []).all[0].qty).toBe(999_999);

    // huge 를 축출 → 오라클(전량 재소비)과 같아야 한다. 종전 결함의 모양이라면 999_999 가
    // 남아 "창 밖으로 밀려난 벽이 계속 보이는" 상태가 된다.
    const slid = [...rest, mkOb(21)];
    const fresh = new IncrementalPeakWallSource('ask');
    expect(src.update(slid, [], OPEN_MS, []).all)
      .toEqual(fresh.update(slid, [], OPEN_MS, []).all);
    expect(src.update(slid, [], OPEN_MS, []).all.some((c) => c.qty === 999_999)).toBe(false);
  });
});

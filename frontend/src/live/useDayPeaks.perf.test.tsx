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

  it('updateAsOf(cutoff)도 append-only 에서 델타만 소비한다 (cutoff 재스캔 회귀 가드, ADR-0106)', () => {
    // #1 의 핵심: cutoff pref ON 이어도 매 틱 ob 를 재스캔하지 않는다. updateAsOf 는
    // accumulate(consumeOb)를 공유하므로 delta-only 불변식이 그대로 성립하고, cutoff 는
    // classify 단계에서만 적용된다(누적과 무관).
    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    const src = new IncrementalPeakWallSource('ask');
    const ob: ObSnapshot[] = Array.from({ length: 1000 }, (_unused, i) => mkOb(i));
    const cutoff = base + 500 * 1000; // 중간 지점(팬 백)

    src.updateAsOf(ob, [], [], cutoff, OPEN_MS);
    const afterFull = spy.mock.calls.length;
    expect(afterFull).toBe(1000); // 첫 소비 = 전체 1회

    // cutoff 밖 틱 append(스크롤백 실사용) — 델타 1개만 소비, cutoff 는 재스캔 유발 안 함.
    // 라이브 버퍼는 append-only 로 참조가 안정하므로 append 배열을 1회 만들어 재사용한다.
    const obPlus = [...ob, mkOb(1000)];
    src.updateAsOf(obPlus, [], [], cutoff, OPEN_MS);
    expect(spy.mock.calls.length - afterFull).toBe(1);

    // cutoff 를 옮겨도(팬) 재소비 없음 — classify 만 다시 돌 뿐 consumeOb 는 호출 안 됨.
    const afterAppend = spy.mock.calls.length;
    src.updateAsOf(obPlus, [], [], base + 200 * 1000, OPEN_MS);
    expect(spy.mock.calls.length - afterAppend).toBe(0);

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
 * 슬라이딩 축출(15분 창)에서 prefix-guard 가 깨지는 **알려진 결함**의 마커.
 *
 * 위 두 테스트는 배열이 **append-only** 이거나 **통째로 교체**되는 두 경우만 본다.
 * 실제 라이브 버퍼는 세 번째 모양을 만든다 — **앞을 자르고 뒤에 붙인다**(15분 슬라이딩).
 * 그 모양에서 prefix 참조가 어긋나 매 flush 마다 전량 재소비가 발생한다. 기존 테스트가
 * 이 축을 **원리적으로 못 보는 것**이 결함이 숨은 이유였다(감사 트랙 1-3).
 *
 * ## 왜 `it.fails` 인가
 *
 * 감사는 "지금 반드시 빨개야 한다" 고 했지만, 항상 빨간 테스트는 무시되기 시작해
 * 메커니즘 전체를 죽인다(CLAUDE.md 「가드를 고칠 때」). `it.fails` 는 그 둘을 화해시킨다:
 * **결함이 있는 지금은 초록**(예상대로 실패했으므로), **고쳐지는 순간 이 테스트가 실패**해
 * "마커를 걷고 진짜 단언으로 바꿔라" 라고 알려 준다.
 *
 * ## 고칠 때 읽을 것 — 기계적 이식은 오히려 나쁘다
 *
 * `locate()` 를 그냥 축출에 강하게 만들면 `events` 가 세션 내내 단조 증가한다
 * (`classify()` 는 매 호출 `this.events` 를 전량 순회하고 가지치기 경로가 `reset()`
 * 뿐이다). 그러면 ①classify 비용이 오히려 커지고 ②창 밖으로 밀려난 벽이 남아 배치
 * 오라클과 갈라진다. **지금의 깨진 가드가 정확성과 메모리 상한을 우연히 지켜 주고 있다.**
 * 올바른 수정은 `locate()` + 축출 조정(`events` prefix 절단 + `eventIndexByKey` 의
 * `baseOffset` 리베이스 + `touchTimes`/`touchPrices` prefix 컷)이다.
 *
 * ## 착수 전 선행 조건
 *
 * 입력 N 이 **미측정**이다 — 장중 1회 계측(차트 창 1개의 `live.ob.length`)이 필요하다.
 * 1 ob/s 면 flush 당 12 ms, 20 ob/s 면 310 ms 로 26배 갈린다. 그 값에 따라 이 항목의
 * 순위가 최상위일 수도, 무시해도 될 수준일 수도 있다.
 */
describe('live day peak — 알려진 결함 마커 (슬라이딩 축출)', () => {
  it.fails('축출 갱신이 델타만 소비한다 — 아직 아니다(고쳐지면 이 테스트가 실패한다)', () => {
    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    const src = new IncrementalPeakWallSource('ask');
    const ob: ObSnapshot[] = Array.from({ length: 2000 }, (_unused, i) => mkOb(i));

    src.update(ob, [], OPEN_MS, []);
    const afterFull = spy.mock.calls.length;

    // 슬라이딩 창: 앞 1개를 버리고 뒤 1개를 붙인다(라이브 버퍼의 실제 모양).
    src.update([...ob.slice(1), mkOb(2000)], [], OPEN_MS, []);
    const delta = spy.mock.calls.length - afterFull;
    spy.mockRestore();

    // 이상적으로는 델타 1~2 여야 한다. 현재는 전량 재소비(2000)라 이 단언이 실패하고,
    // `it.fails` 가 그 실패를 **예상된 것**으로 받아 스위트를 초록으로 유지한다.
    expect(delta).toBeLessThanOrEqual(2);
  });
});

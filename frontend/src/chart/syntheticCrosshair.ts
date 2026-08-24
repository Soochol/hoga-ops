/**
 * 이 차트의 크로스헤어가 **지금 합성인가** — 내 포인터가 아니라 옆 창의 호버를
 * `CursorSyncCrosshair` 가 `setCrosshairPosition` 으로 옮겨 그린 것인가.
 *
 * 차트 인스턴스를 키로 쓰는 `WeakSet` 하나가 전부다. 창 id 를 실어 나르지 않는
 * 이유는 묻는 쪽과 답하는 쪽이 **같은 `IChartApi` 객체**를 이미 쥐고 있어서다
 * (`LiveChartRoot` 가 만들어 `CursorSyncCrosshair` 에 prop 으로 넘긴다). 차트가
 * 버려지면 항목도 함께 사라지므로 정리 경로가 따로 필요 없다.
 *
 * ── 왜 필요한가 (2026-08-24 실측) ─────────────────────────────────────────
 * 분봉 창 A 의 **캔들 오른쪽 빈 공간**에 마우스를 움직이면 A 의 크로스헤어가 몇 분·
 * 며칠 전 임의 캔들로 튀어 눌어붙었다(`/browse` 재현, 15 사이클 중 2회).
 *
 * ① A 가 빈 공간에 들어가면 sync 슬롯을 비운다(`clearSidebarCursor`). ② 그때까지
 * 소비 창 B 는 합성 크로스헤어를 들고 있었고, lwc 는 데이터 갱신마다 그 저장 좌표를
 * 재적용하며 `crosshairMove` 를 **재발화**한다(`sourceEvent` 없음). ③ B 의 핸들러는
 * 그 이벤트를 rAF 로 미룬다. ④ 미뤄진 rAF 가 ①의 뒤에 착지하면, 슬롯이 비어 있어
 * `LiveChartRoot` 의 소유자 가드가 통과하고 B 가 **자기 stale 위치를 B 의 origin 으로**
 * 발행한다. ⑤ A 가 그것을 소비해 자기 차트에 크로스헤어를 건다 — 그것이 점프다.
 * 슬롯 주인이 B 라 A 의 `clearSyncCursorFrom(A)` 는 no-op 이고, 분봉 번들이 틱마다
 * 갱신되며 effect 가 재실행돼 **틱마다 다시 걸린다**.
 *
 * ── 막는 방향 ────────────────────────────────────────────────────────────
 * **합성 크로스헤어에서 나온 재발화가 빈 슬롯을 차지하는 것.** 소유자 가드가 못 보는
 * 구간(슬롯이 `null`)을 정확히 이 축이 덮는다.
 *
 * ── 못 보는 것 ───────────────────────────────────────────────────────────
 * - **실제 포인터 입력은 통과시킨다.** 사용자가 그 창으로 마우스를 옮기면 발행자가
 *   바뀌는 게 맞다(2026-08-12 가드와 같은 방향).
 * - **합성이 아닌 재발행은 막지 않는다.** 포인터가 멈춰 있는 창이 옆 창의 발행이
 *   풀린 뒤 슬롯을 되찾는 경로가 그것이다(`publishCursorMs` 의 「값이 같아도 다시
 *   발행한다」). 그 경로까지 막으려면 `fromUserPointer` 를 발행 조건으로 요구해야
 *   하는데, 그것이 정확히 이 파일이 피하려는 회귀다.
 * - 이 표시는 **위치를 담지 않는다** — "합성이다/아니다" 뿐이다. 어느 창이 걸었는지는
 *   슬롯의 origin 이 갖는다.
 *
 * ── 등록 의존 ────────────────────────────────────────────────────────────
 * `setCrosshairPosition` 을 부르는 **모든** 곳이 여기 표시를 남겨야 성립한다. 지금
 * 그 호출처는 `CursorSyncCrosshair` 하나뿐이고, 새 호출처가 생기면 같이 표시해야
 * 한다(`grep setCrosshairPosition`). 표시를 빠뜨리면 가드가 **조용히** 열린다.
 */
import type { IChartApi } from 'lightweight-charts';

const synthetic = new WeakSet<IChartApi>();

/**
 * 합성 크로스헤어를 걸었다고 표시한다.
 *
 * **`setCrosshairPosition` 을 부른 뒤에** 부를 것. lwc 는 그 호출에서
 * `skipEvent = true` 로 `crosshairMove` 를 쏘지 않으므로 그 사이에 끼어드는 이벤트가
 * 없고, 호출이 던지면 표시가 남지 않는다 — 남으면 위 「못 보는 것」의 재획득 경로가
 * 그 창에서 영영 막힌다.
 */
export function markSyntheticCrosshair(chart: IChartApi): void {
  synthetic.add(chart);
}

/** 합성 크로스헤어를 걷었다고 표시한다(`clearCrosshairPosition` 과 짝). */
export function releaseSyntheticCrosshair(chart: IChartApi): void {
  synthetic.delete(chart);
}

/**
 * 지금 이 차트의 크로스헤어가 합성인가.
 *
 * ⚠ **읽는 시점이 계약이다.** 발행을 결정하는 rAF 안이 아니라 `crosshairMove`
 * **이벤트 핸들러 안**에서 읽어 그 값을 rAF 로 넘겨야 한다. 실측한 순서가
 * `슬롯 비움 → 소비 창 cleanup(합성 해제) → 미뤄진 rAF 발행` 이라, rAF 안에서 읽으면
 * 이미 해제된 뒤라 **항상 false 를 보고 가드가 통째로 무력해진다**. 같은 파일의
 * `hasSourceEvent`·`point` 를 rAF 밖에서 뽑는 것과 같은 이유(원인은 다르다 — 그쪽은
 * lwc 의 param 재사용이고, 이쪽은 해제와의 경쟁이다).
 */
export function hasSyntheticCrosshair(chart: IChartApi): boolean {
  return synthetic.has(chart);
}

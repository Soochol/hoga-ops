/**
 * lightweight-charts 구독 해제를 cleanup 안전하게 감싼다.
 *
 * 해제는 차트 파괴 레이스에서 throw 한다 — 부모의 `chart.remove()` 가 자식 오버레이의
 * cleanup 보다 먼저 돌면 내부 핸들이 dangling 이 되고 lwc 가 "Value is undefined" 를
 * 던진다. RangeSeriesPane 이 `removeSeries` 를 try/catch 로 감싸는 것과 같은 이유이고,
 * 구독 해제도 정확히 같은 레이스에 놓인다(오버레이가 차트보다 오래 살 수 없으므로).
 *
 * 무엇이 깨지나 (2026-07-29 실측):
 *  - **같은 cleanup 안에서 throw 뒤의 문장이 스킵된다.** React 의미론이 아니라 그냥 JS
 *    다. 해제를 첫 줄에 둔 cleanup 이 많은데(LiveChartRoot 의 크로스헤어 cleanup 이
 *    대표적) 그 뒤에 rAF 취소·타이머 취소·스토어 리셋이 줄줄이 달려 있다. 한 번
 *    throw 하면 rAF 와 타이머가 살아남고 커서 상태가 리셋 안 된 채 굳는다.
 *  - 예외가 호출자로 전파돼 ChartErrorBoundary 를 때린다 — 해체 중 pane 이 통째로
 *    에러 상태가 된다.
 *  (반면 **다른 effect 의 cleanup 은 정상 실행된다** — React 가 effect 단위로 격리한다.
 *   실측 확인. 여기서 막는 건 "커밋 전체"가 아니라 이 cleanup 의 꼬리다.)
 *
 * 삼켜도 안전한 이유: 해제가 throw 하는 경로는 차트가 이미 파괴된 경우이고, 그때는
 * 구독도 함께 사라졌으므로 해제할 대상이 없다. 즉 실패한 해제는 "이미 달성된 상태"다.
 * 살아 있는 차트에서의 해제는 던지지 않으므로 이 래퍼가 실제 오류를 감추지 않는다.
 */
export function safeUnsubscribe(unsubscribe: () => void): void {
  try {
    unsubscribe();
  } catch {
    // chart already torn down — the subscription died with it
  }
}

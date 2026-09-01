/**
 * 갱신 루프 덫 — **한 프레임 안에서 어느 스토어가 몇 번 쓰였는지**를 세고, 폭주하는
 * 쓰기의 **호출 스택**을 남긴다.
 *
 * ## 왜 필요한가
 *
 * `/live` 차트가 React 의 **"Maximum update depth exceeded"** 로 죽는다(2026-09-01).
 * 던지는 쪽은 react-dom 의 `checkForNestedUpdates` 이고, 조건은 커밋 직후
 * `pendingLanes` 에 **SyncLane** 이 남는 커밋 50회 연속이다. passive effect 는 SyncLane 이
 * 아니므로(그쪽은 경고만 찍는다) 이 예외가 뜨면 사이클은 반드시 **스토어 알림**
 * (zustand·`useSyncExternalStore` 는 `forceStoreRerender` 가 SyncLane 을 명시한다)이나
 * 레이아웃 단계 setState 를 지난다.
 *
 * 컴포넌트 스택(#1686)은 **던진 파이버**를 알려 준다 — 실측 결과 `LiveChartRoot` 였다.
 * 그러나 매 커밋 스토어를 **쓰는 쪽**은 다른 곳일 수 있다(스토어 알림은 트리 경계를
 * 넘는다). 이 덫이 그 나머지 절반이다.
 *
 * ## 왜 «프레임당» 인가 — 시간당이 아니라
 *
 * 시간창(예: 500ms)으로 세면 **정상 활동이 걸린다**: 팬·줌 중 커서 스토어는 rAF 박자로
 * 초당 60회 쓰이고 WS 틱도 비슷하다. 그건 프레임마다 1~2회일 뿐이다. 폭주는 **한
 * 프레임 안에서** 수십 번 쓴다 — SyncLane 재렌더가 페인트에 양보하지 않고 동기적으로
 * 돌기 때문이다(그래서 예외도 1초가 아니라 1ms 만에 뜬다). 프레임 경계에서 0 으로
 * 되돌리면 두 상황이 자릿수로 갈린다.
 *
 * ## 스택은 «의심스러운 프레임에서만» 뜬다
 *
 * 쓰기마다 `new Error().stack` 을 뜨면 정상 경로에도 비용이 붙는다. 그래서 한 프레임에서
 * 같은 스토어가 `STACK_WATERMARK` 를 넘은 뒤에만 뜬다 — 정상 활동은 그 선을 넘지 않아
 * 비용이 0 이고, 폭주는 몇 번 안에 넘는다.
 *
 * ## 계약
 *
 * - **무장 전에는 완전한 no-op.** 무장은 `updateLoopWatch.ts` 가 DEV 에서만 한다
 *   (vitest 도 `DEV` 가 참이므로 그쪽에서 `MODE === 'test'` 를 함께 본다).
 * - **관측만 한다** — 상태를 쓰지 않고 던지지 않는다. 관측 호출이 동작을 취소하는
 *   실패 유형을 이 리포가 이미 겪었다.
 * - **첫 신고만 남긴다(래치)**. 폭주 중엔 같은 스택이 수백 번 나오고, 두 번째부터는
 *   새 사실 없이 콘솔만 덮는다.
 */

/** 한 프레임에서 이 횟수를 넘긴 스토어는 폭주로 본다. 정상 최대치(프레임당 1~2회)와
 *  자릿수가 달라 경계에 민감하지 않다. */
const WRITES_PER_FRAME_LIMIT = 20;
/** 이 횟수부터 스택을 뜬다 — 그 아래에서는 비용을 내지 않는다. */
const STACK_WATERMARK = 5;

export type UpdateLoopReport = {
  /** 폭주한 스토어 이름(`updateLoopWatch` 의 등록 이름). */
  store: string;
  /** 그 프레임에서 관측된 쓰기 횟수. */
  writes: number;
  /** 한계를 넘긴 그 쓰기의 호출 스택. 알림이 `setState` 안에서 **동기적으로** 도는
   *  덕에 여기에는 **쓴 쪽**의 프레임이 그대로 들어 있다. */
  stack: string;
  /** 같은 프레임의 다른 스토어들 — 루프에 함께 실린 것을 본다(`이름×횟수`). */
  frameHistogram: readonly (readonly [string, number])[];
  at: string;
};

let armed = false;
let report: UpdateLoopReport | null = null;
let counts = new Map<string, number>();
let frameScheduled = false;

/** 프레임 경계에서 계수를 0 으로. rAF 가 없는 환경(SSR·일부 테스트)에서는 세지 않는다
 *  — 거기엔 폭주를 만들 렌더 루프도 없다. */
function scheduleFrameReset(): void {
  if (frameScheduled) return;
  if (typeof requestAnimationFrame !== 'function') return;
  frameScheduled = true;
  requestAnimationFrame(() => {
    frameScheduled = false;
    counts = new Map();
  });
}

/**
 * 스토어가 한 번 쓰였다고 알린다. 무장 전에는 아무 일도 하지 않는다.
 *
 * zustand 스토어는 `updateLoopWatch` 가 `subscribe` 로 자동 배선하므로 직접 부를 일이
 * 없다. `subscribe` 가 없는 손수 만든 발행 채널만 자기 알림 함수에서 부른다.
 */
export function noteStoreWrite(store: string): void {
  if (!armed || report !== null) return;
  scheduleFrameReset();
  const writes = (counts.get(store) ?? 0) + 1;
  counts.set(store, writes);
  if (writes < STACK_WATERMARK) return;
  const stack = new Error('update-loop').stack ?? '(스택 없음)';
  if (writes < WRITES_PER_FRAME_LIMIT) return;
  report = {
    store,
    writes,
    stack,
    frameHistogram: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    at: new Date().toISOString(),
  };
  // DevTools 를 연 사람은 폴백 상자를 기다릴 필요가 없다.
  console.error(
    `[update-loop] "${store}" 가 한 프레임에 ${writes}회 쓰였다 — 갱신 루프로 의심된다.`,
    stack,
  );
}

/** DEV 무장 스위치(`updateLoopWatch.installUpdateLoopWatch` 전용). */
export function armUpdateLoopSignal(): void {
  armed = true;
}

/** 지금까지 잡힌 신고. 없으면 `null`. `ChartErrorBoundary` 의 「오류 복사」가 읽는다. */
export function readUpdateLoopReport(): UpdateLoopReport | null {
  return report;
}

/** 신고를 사람이 읽을 한 덩어리로 — 폴백 상자가 클립보드에 덧붙인다. */
export function formatUpdateLoopReport(r: UpdateLoopReport): string {
  const hist = r.frameHistogram.map(([name, n]) => `${name}×${n}`).join(' · ');
  return [
    `[update-loop] store=${r.store} writes-in-one-frame=${r.writes} at=${r.at}`,
    `frame: ${hist}`,
    r.stack,
  ].join('\n');
}

/** 테스트·재무장용. */
export function resetUpdateLoopReport(): void {
  report = null;
  counts = new Map();
}

/** 테스트 전용 — 무장을 되돌린다(모듈 상태가 파일 간에 새지 않게). */
export function __disarmUpdateLoopSignalForTests(): void {
  armed = false;
  resetUpdateLoopReport();
}

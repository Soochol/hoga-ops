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
 * ## 왜 스택에 react-dom 이 있어야 신고하는가
 *
 * 프레임당 계수만으로는 **키 분산 배치**를 폭주와 구별하지 못한다. 실측 위양성:
 * `promotion_completed` WS 이벤트가 종목마다 오므로 한 배치에 20종목이면
 * `livePromotion` 에 **서로 다른 키의 진짜 상태 변경 20건**이 한 프레임에 들어간다
 * (zustand 는 `Object.is` 로 no-op 쓰기를 걸러 알림조차 하지 않으니 전부 실제 변경이다).
 * 자기증식 루프가 아닌데 덫이 탄다.
 *
 * 가르는 축은 **그 쓰기를 React 가 몰았는가**이고, 근거는 react-dom 18.3.1 원문이다:
 * `commitRootImpl` 은 커밋 끝에서 `root.pendingLanes` 에 SyncLane 이 **남아 있을 때만**
 * `nestedUpdateCount` 를 올리고, 아니면 **0 으로 리셋한다**. 그래서 던지는 결함의
 * 쓰기는 반드시 렌더/커밋 **안에서 동기적으로** 일어나고 — 그 스택에는 react-dom
 * 프레임이 있다 — 외부 콜백(WS·rAF·microtask)의 쓰기는 커밋이 끝난 뒤에 착지해
 * 카운터를 도로 0 으로 만든다. 즉 **표적은 정의상 react-dom 을 지나고, 위양성은
 * 정의상 지나지 않는다.**
 *
 * 이 가드가 닫는 방향과 한계(#1688):
 *
 * - **막는 방향**: 외부 콜백이 한 프레임에 낸 키 분산 배치. 그 스택엔 react-dom 이 없다.
 * - **못 보는 것 셋**:
 *   ① **React 발 키 분산 배치** — 창 20개가 한 커밋에 마운트되면 `registry:*` 가
 *      layout effect 에서 20회 쓰이고 스택엔 react-dom 이 있다. 게이트를 통과한다.
 *      **스토어별 래치가 필요한 진짜 이유가 이것이다**(아래).
 *   ② **한계를 넘긴 그 쓰기만 본다** — 19회가 비-React 이고 20번째만 React 면 통과한다.
 *   ③ **React 밖 순수 스토어 폭주** — 원래 이 예외를 던지지 않으므로 표적 밖이다.
 *      (그래도 세기는 한다 — 히스토그램에는 남는다.)
 * - **등록 의존**: 판별은 `isReactDrivenStack` 의 토큰 목록에 달렸다. React 를 올리며
 *   내부 함수명이 바뀌면 `updateLoopSignal.test.ts` 의 **진짜 커밋 테스트가 빨개진다** —
 *   그때 고칠 것은 토큰 목록이다.
 *
 * ## 스택은 «한계를 넘은 뒤에만» 뜨고, 짧게 뜨면 안 된다
 *
 * 쓰기마다 `new Error().stack` 을 뜨면 정상 경로에도 비용이 붙는다. 그래서 한 프레임에서
 * 같은 스토어가 `WRITES_PER_FRAME_LIMIT` 에 닿은 뒤에만 뜬다 — 정상 활동은 그 선을
 * 넘지 않아 비용이 0 이다.
 *
 * 그리고 **`Error.stackTraceLimit` 을 올려서** 떠야 한다. 기본값은 10 인데 실측한 커밋
 * 스택에서 react-dom 프레임은 **7~10번째**였다(`noteStoreWrite` → `updateLoopWatch` 의
 * 구독 화살표 → zustand `setState` → 스토어 액션 → 이펙트 본문 → `commit*`). 앱 헬퍼가
 * 한 겹만 더 끼면 react-dom 이 **잘려 나가고**, 그러면 게이트가 표적을 통째로 놓친다 —
 * 지금의 위양성보다 나쁜 상태다. 신고에 실리는 스택이 길어지는 것도 그대로 이득이다.
 *
 * ## 계약
 *
 * - **무장 전에는 완전한 no-op.** 무장은 `updateLoopWatch.ts` 가 DEV 에서만 한다
 *   (vitest 도 `DEV` 가 참이므로 그쪽에서 `MODE === 'test'` 를 함께 본다).
 * - **관측만 한다** — 상태를 쓰지 않고 던지지 않는다. 관측 호출이 동작을 취소하는
 *   실패 유형을 이 리포가 이미 겪었다. (`Error.stackTraceLimit` 은 캡처 한 번을
 *   감싸고 곧바로 되돌리므로 앱 상태도 제어 흐름도 건드리지 않는다.)
 * - **스토어마다 첫 신고만 남긴다(래치)**. 폭주 중엔 같은 스택이 수백 번 나오고,
 *   두 번째부터는 새 사실 없이 콘솔만 덮는다 — 그 근거는 **같은 스토어**에만 성립한다.
 *   다른 스토어의 다른 스택은 새 사실이므로 막지 않는다. 래치를 전역으로 두면 위양성
 *   하나가 그 세션 내내 **덫 전체의 눈을 감기고**, 정작 잡으려던 폭주가 안 보인다.
 */

/** 한 프레임에서 이 횟수를 넘긴 스토어는 폭주로 본다. 정상 최대치(프레임당 1~2회)와
 *  자릿수가 달라 경계에 민감하지 않다. */
const WRITES_PER_FRAME_LIMIT = 20;

/** 캡처할 스택 프레임 수. 기본 10 으로는 react-dom 이 잘린다(머리말의 실측). */
const STACK_FRAMES = 60;

/** react-dom 프레임의 지문. **두 종류를 함께 보는 것이 의도다** — 둘의 고장 방식이
 *  다르기 때문이다.
 *
 *  - **모듈 경로**: vitest 는 `node_modules/react-dom/cjs/react-dom.development.js`,
 *    Vite dev 브라우저는 `node_modules/.vite/deps/react-dom-<해시>.js`(실측) 라
 *    양쪽 다 이 토큰을 담는다. React 가 내부 함수명을 바꿔도 살아남는다.
 *  - **내부 함수명**: 번들러가 react-dom 을 이름 없는 청크로 합치면 경로 토큰이
 *    죽는데 이름은 남는다(esbuild·rolldown 은 dev 에서 이름을 보존한다 — 실측).
 *
 *  프로덕션 번들에는 이 모듈 자체가 들어가지 않으므로 난독화된 이름은 고려 대상이 아니다. */
const REACT_DOM_MODULE_TOKEN = 'react-dom';
const REACT_DOM_FRAME_NAMES = [
  'renderWithHooks',
  'beginWork',
  'performSyncWorkOnRoot',
  'performConcurrentWorkOnRoot',
  'commitRootImpl',
  'commitHookEffectListMount',
  'commitLayoutEffectOnFiber',
  'commitPassiveMountOnFiber',
  'flushSyncCallbacks',
] as const;

export type UpdateLoopReport = {
  /** 폭주한 스토어 이름(`updateLoopWatch` 의 등록 이름). */
  store: string;
  /** 그 프레임에서 관측된 쓰기 횟수. */
  writes: number;
  /** 한계를 넘긴 그 쓰기의 호출 스택. 알림이 `setState` 안에서 **동기적으로** 도는
   *  덕에 여기에는 **쓴 쪽**의 프레임이 그대로 들어 있다. */
  stack: string;
  /** 같은 프레임의 다른 스토어들 — 루프에 함께 실린 것을 본다(`이름×횟수`).
   *  게이트에 걸린 스토어도 여기에는 남는다(계수는 모든 쓰기를 센다). */
  frameHistogram: readonly (readonly [string, number])[];
  at: string;
};

let armed = false;
let reports: UpdateLoopReport[] = [];
let reported = new Set<string>();
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

/** 스택 한 장 — 기본 한계(10)보다 깊게 뜨고 곧바로 되돌린다. `stackTraceLimit` 은
 *  V8(Chrome·Node) 전용이라 표준 타입 정의에 없어 캐스트한다. 다른 엔진에서는 없는
 *  프로퍼티를 읽어 `raise` 가 거짓이 되므로 아무것도 건드리지 않는다. */
function captureStack(): string {
  const E = Error as { stackTraceLimit?: number };
  const prev = E.stackTraceLimit;
  const raise = typeof prev === 'number' && prev < STACK_FRAMES;
  if (raise) E.stackTraceLimit = STACK_FRAMES;
  try {
    return new Error('update-loop').stack ?? '(스택 없음)';
  } finally {
    if (raise) E.stackTraceLimit = prev;
  }
}

/** 이 스택이 **React 의 렌더/커밋 안에서** 난 쓰기인가. 머리말의 「왜 react-dom 이
 *  있어야 신고하는가」가 근거이고, 토큰 목록의 드리프트는 진짜 커밋 테스트가 잡는다. */
export function isReactDrivenStack(stack: string): boolean {
  if (stack.includes(REACT_DOM_MODULE_TOKEN)) return true;
  return REACT_DOM_FRAME_NAMES.some((name) => stack.includes(name));
}

/**
 * 스토어가 한 번 쓰였다고 알린다. 무장 전에는 아무 일도 하지 않는다.
 *
 * zustand 스토어는 `updateLoopWatch` 가 `subscribe` 로 자동 배선하므로 직접 부를 일이
 * 없다. `subscribe` 가 없는 손수 만든 발행 채널만 자기 알림 함수에서 부른다.
 */
export function noteStoreWrite(store: string): void {
  if (!armed) return;
  scheduleFrameReset();
  // 계수는 **모든** 쓰기를 센다 — 게이트에 걸릴 쓰기도 히스토그램에는 남아야 진짜
  // 신고 옆에서 「그 프레임에 뭐가 같이 돌았는지」를 보여 준다.
  const writes = (counts.get(store) ?? 0) + 1;
  counts.set(store, writes);
  if (writes < WRITES_PER_FRAME_LIMIT) return;
  if (reported.has(store)) return;
  const stack = captureStack();
  if (!isReactDrivenStack(stack)) return;
  reported.add(store);
  const next: UpdateLoopReport = {
    store,
    writes,
    stack,
    frameHistogram: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    at: new Date().toISOString(),
  };
  reports.push(next);
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

/** 가장 먼저 잡힌 신고. 없으면 `null`. 폴백 상자의 헤드라인이 읽는다. */
export function readUpdateLoopReport(): UpdateLoopReport | null {
  return reports[0] ?? null;
}

/** 잡힌 신고 **전부**(스토어마다 하나). `ChartErrorBoundary` 의 「오류 복사」가 읽는다 —
 *  루프에 두 스토어가 실렸으면 둘 다 한 번의 붙여넣기로 와야 한다. */
export function readUpdateLoopReports(): readonly UpdateLoopReport[] {
  return reports;
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
  reports = [];
  reported = new Set();
  counts = new Map();
}

/** 테스트 전용 — 무장을 되돌린다(모듈 상태가 파일 간에 새지 않게). */
export function __disarmUpdateLoopSignalForTests(): void {
  armed = false;
  resetUpdateLoopReport();
}

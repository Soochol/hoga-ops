/**
 * WindowViewContext — 창-스코프 뷰 컨텍스트의 **런타임 최소 모듈**.
 *
 * `windowView.ts` 에서 컨텍스트 객체와 그 타입만 떼어낸 파일이다. 훅 구현은
 * 그대로 `windowView.ts` 에 있고 여기 것을 re-export 한다 — 소비자는 종전대로
 * `windowView` 에서 import 하면 된다.
 *
 * 왜 쪼개는가: `state/chartPrefs.ts` 가 창의 봉을 알아야 하는데(indicator-modal
 * prefs 의 per-timeframe 버킷 resolve), `windowView.ts` 는 livePage·workspace
 * 스토어를 **런타임** import 한다. livePage 는 다시 chartPrefs 를 import 하므로
 * chartPrefs → windowView → livePage → chartPrefs 순환이 생긴다. 이 파일은
 * 런타임 의존이 `react` 뿐이고 나머지는 전부 `import type`(컴파일 시 소거)이라
 * 순환 없이 컨텍스트를 공유할 수 있다.
 */
import { createContext } from 'react';
import type { LiveTimeframe } from '../../state/livePage';
import type { ChartWindowConfig, ChartWindowRuntime, GroupId } from '../../state/workspace';

export interface WindowView {
  /** null = 전역(창 없음, Provider 밖). */
  windowId: string | null;
  group: GroupId | null;
  code: string | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
}

/**
 * 창-스코프 훅이 읽고 쓰는 워크스페이스 스토어의 **최소 상태**. `/live`
 * `useWorkspaceStore` 와 (2026-08-23 삭제된) `/study` 스토어가 이 모양을 공유했으므로
 * (#906 이 창 설정 타입을 공유하게 만든 이유) 훅은 어느 쪽인지 몰라도 된다.
 *
 * `windows` 원소를 `{id, chart?}` 로만 좁힌 게 요점이다 — `/live` 의 `group`·`rect`,
 * `/study` 의 `kind` 처럼 한쪽에만 있던 필드에 훅이 손대지 못한다.
 *
 * **지표 액션은 여기 없다.** 지표 설정은 앱 전역 저장소(`live.indicators.v2`)에
 * 있고, 창이 정하는 것은 "어느 버킷을 편집하는가"(페이지 + 봉) 뿐이다 —
 * `windowView.ts` 의 창 액션이 전역 스토어의 `patchIndicatorsScoped` 를 어댑터의
 * `scopePrefix` 와 창의 `chart.timeframe` 으로 바인딩한다. 창이 소유하는 쓰기
 * 경로는 봉과 백필뿐이다.
 */
export interface WindowChartStoreState {
  windows: readonly { id: string; chart?: ChartWindowConfig }[];
  zOrder: readonly string[];
  chartRuntime: Record<string, ChartWindowRuntime>;
  extendChartHistoricalRange: (id: string, date: string) => void;
  /** 창을 앞으로 당긴다(축소) — `extend` 의 반대. 근거는 스토어 구현 주석. */
  contractChartHistoricalRange: (id: string, date: string) => void;
  resetChartHistoricalRange: (id: string) => void;
}

/**
 * 창 지표 스코프 키 — 창별 지표 세트의 저장소 키(`live.indicators.v2` 의 `byWindow`).
 *
 * `windowId` 가 null(=Provider 밖, 단일 차트·테스트)이면 null 이고, 그 null 이 곧
 * "앱 세트를 본다"는 뜻이다. 두 스토어(`livePage`·`chartPrefs`)가 **같은 키**를 써야
 * 멤버십이 어긋나지 않으므로 파생을 여기 한 곳에 둔다 — chartPrefs 는 `windowView` 를
 * import 할 수 없다(이 파일 상단의 순환 주석 참조).
 */
/**
 * ⚠ `live:` 는 **축이 아니라 영속 키의 화석**이다.
 *
 * 한때 `scopePrefix: 'live' | 'study'` 가 어댑터에서 왔고 페이지마다 갈렸다(ADR-0146).
 * `/study` 가 사라져(ADR-0157) 축은 걷혔지만 **접두는 남긴다** — 사용자 디스크의
 * `live.indicators.v2 → byWindow` 키가 이미 `live:<id>` 모양이라, 떼는 순간 기존
 * 창별 지표 설정이 전부 조회 불가가 되고 모든 창이 조용히 앱 세트로 되붙는다.
 *
 * **새 접두를 추가하지 말 것.** 두 번째 값이 필요해지는 날엔 문자열 접두가 아니라
 * 축(`IndicatorScope` 의 필드)을 다시 세우는 것이 맞다 — 접두에 의미를 싣기 시작하면
 * 저장 키 포맷에 로직이 묶인다.
 */
const WINDOW_SCOPE_PREFIX = 'live';

export function windowScopeKey(windowId: string | null | undefined): string | null {
  return windowId ? `${WINDOW_SCOPE_PREFIX}:${windowId}` : null;
}

/** 창이 공급하는 완전한 뷰 값.
 *
 *  ⚠ 여기 `workspace: WindowWorkspaceAdapter` 가 있었다(#901) — 창-스코프 훅이
 *  `/live`·`/study` 두 스토어 중 **어느 쪽인지** 주입받는 통로였고, 빠뜨리면 훅이
 *  조용히 다른 스토어를 보는 것이 그 작업이 없애려던 결함이었다. `/study` 폐지
 *  (ADR-0157)로 스토어가 하나가 되면서 그 결함이 **구조적으로 불가능**해졌고,
 *  훅들은 `useWorkspaceStore` 를 직접 본다.
 *
 *  지표는 값으로 싣지 않는다 — `useWindowIndicators` 가 그 페이지의 버킷을 이 값의
 *  `timeframe` 으로 resolve 한다. 여기 사본을 두면 진실이 둘이 되고, 다른 탭이
 *  바꾼 설정이 이 사본을 갱신하지 않아 화면만 낡는다. */
export interface WindowViewValue extends WindowView {
}

// 불변식: 한 컴포넌트 인스턴스의 windowId 는 수명 동안 바뀌지 않는다(창=컴포넌트
// 1:1, WorkspaceCanvas 가 key=win.id 로 마운트). useMemo([windowId]) 캐시·effect
// deps 생략이 이 불변식에 기댄다 — 창 재사용(id 교체) 최적화 금지.
export const WindowViewContext = createContext<WindowViewValue | null>(null);

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
 * `useWorkspaceStore` 와 `/study` `useStudyWorkspaceStore` 가 이 모양을 공유하므로
 * (#906 이 창 설정 타입을 공유하게 만든 이유) 훅은 어느 쪽인지 몰라도 된다.
 *
 * `windows` 원소를 `{id, chart?}` 로만 좁힌 게 요점이다 — `/live` 의 `group`·`rect`,
 * `/study` 의 `kind` 처럼 한쪽에만 있는 필드에 훅이 손대지 못한다.
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
  resetChartHistoricalRange: (id: string) => void;
}

/**
 * 스토어 핸들 — **zustand 훅 그대로** 여야 한다. 평범한 함수 묶음(`getState` 만
 * 가진 객체)으로 바꾸면 `useWindowLayoutSlice`·`useIsFocusedWindow` 의 selector
 * 구독이 사라져 창 설정을 바꿔도 재렌더가 안 온다(#901 이 (A)안을 "핸들 주입 +
 * 창 모양 동형화" 한 결정으로 묶은 이유).
 */
export interface WindowStoreHandle {
  <T>(selector: (state: WindowChartStoreState) => T): T;
  getState: () => WindowChartStoreState;
}

/**
 * 창-스코프 훅이 워크스페이스에 닿는 유일한 통로.
 *
 * `store` 로 덮이지 않는 축이 하나 있다: **종목 코드**. `/live` 는 창의 링크 그룹
 * (`groupSymbols[win.group]`)에서 얻지만 `/study` 에는 그룹이 없고 활성 저장뷰가
 * 소스다. 창 모양을 아무리 맞춰도 이 축만은 스토어 밖이라, 코드를 아는 쪽(Provider)이
 * 해석기를 실어 준다. 렌더 클로저가 아니라 **호출 시점** 함수여야 한다 —
 * `useWindowViewGuard` 의 존재 이유가 fresh 읽기다.
 */
export interface WindowWorkspaceAdapter {
  store: WindowStoreHandle;
  /**
   * 이 창의 코드를 **workarea 공간**으로 — 주식=6자리 코드, 지수=`index:<id>`
   * (`liveInstrument.ts` 의 `indexWorkareaCode`).
   *
   * 이름에 공간을 박아 둔 이유: 같은 컨텍스트 값의 `WindowViewValue.code` 는 **다른
   * 공간**이다(지수=null, 전역 `activeCode` 미러). 둘이 갈리는 것은 의도이고, 이름이
   * 같으면 다음 사람이 아무 생각 없이 바꿔 쓴다. 실제로 그 혼동이 지수 창의 좌측 팬
   * 백필을 통째로 죽였다 — 가드가 `'KOSPI' !== 'index:KOSPI'` 로 매번 반려했다.
   *
   * 유일한 소비처는 `buildWindowViewGuard` 다. 지표 스코프 키·드로잉 키 같은 **영속**
   * 저장소는 이 값을 쓰지 않으므로, 공간을 바꿔도 저장된 설정이 무효화되지 않는다.
   */
  getWorkareaCode: (windowId: string) => string | null;
  /**
   * 이 워크스페이스가 속한 **페이지** — 지표 세트의 소유자다(ADR-0146).
   * `/live` 와 `/study` 는 각각 자기 세트를 갖고 서로 동기화하지 않는다.
   *
   * 어댑터가 들고 있는 이유: 이 값을 아는 곳은 워크스페이스 종류를 아는 곳뿐이고,
   * 어댑터는 이미 그런 축(`getWorkareaCode`)을 담는 자리다. 모듈 상수 2개(`LIVE_`/`STUDY_`)
   * 라 **렌더 동기적**이고 참조도 안정적이다 — 전역 "현재 페이지" 슬롯을 두면
   * 라우팅보다 한 커밋 늦어 그 틈에 남의 페이지 버킷이 적용된다.
   */
  scopePrefix: 'live' | 'study';
}

/**
 * 창 지표 스코프 키 — 창별 지표 세트의 저장소 키(`live.indicators.v2` 의
 * `byWindow`). 창 id 는 두 워크스페이스가 독립적으로 발급하므로
 * (`/live`=`newWindowId`, `/study`=`randomUUID`) 접두사로 구별한다.
 *
 * `windowId` 가 null(=Provider 밖, 단일 차트·테스트)이면 null 이고, 그 null 이 곧
 * "페이지 세트를 본다"는 뜻이다. 두 스토어(`livePage`·`chartPrefs`)가 **같은 키**를
 * 써야 멤버십이 어긋나지 않으므로 파생을 여기 한 곳에 둔다 — chartPrefs 는
 * `windowView` 를 import 할 수 없다(이 파일 상단의 순환 주석 참조).
 */
export function windowScopeKey(
  adapter: Pick<WindowWorkspaceAdapter, 'scopePrefix'> | undefined | null,
  windowId: string | null | undefined,
): string | null {
  return adapter && windowId ? `${adapter.scopePrefix}:${windowId}` : null;
}

/** 창이 워크스페이스 통로까지 공급하는 완전한 뷰 값. `workspace` 는 **필수** —
 *  빠뜨리면 훅이 조용히 다른 스토어를 보게 되는데, 그 조용한 폴백이야말로 이
 *  작업이 없애려는 것이다(#901).
 *
 *  지표는 값으로 싣지 않는다 — `useWindowIndicators` 가 그 페이지의 버킷을 이 값의
 *  `timeframe` 으로 resolve 한다. 여기 사본을 두면 진실이 둘이 되고, 다른 탭이
 *  바꾼 설정이 이 사본을 갱신하지 않아 화면만 낡는다. */
export interface WindowViewValue extends WindowView {
  workspace: WindowWorkspaceAdapter;
}

// 불변식: 한 컴포넌트 인스턴스의 windowId 는 수명 동안 바뀌지 않는다(창=컴포넌트
// 1:1, WorkspaceCanvas 가 key=win.id 로 마운트). useMemo([windowId]) 캐시·effect
// deps 생략이 이 불변식에 기댄다 — 창 재사용(id 교체) 최적화 금지.
export const WindowViewContext = createContext<WindowViewValue | null>(null);

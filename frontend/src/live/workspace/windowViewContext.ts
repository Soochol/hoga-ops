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
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import type { GroupId } from '../../state/workspace';

export interface WindowView {
  /** null = 전역(창 없음, Provider 밖). */
  windowId: string | null;
  group: GroupId | null;
  code: string | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
}

/** 창이 자기 지표(resolve 된 IndicatorSettings)까지 공급하는 완전한 뷰 값. */
export interface WindowViewValue extends WindowView {
  indicators: IndicatorSettings;
}

// 불변식: 한 컴포넌트 인스턴스의 windowId 는 수명 동안 바뀌지 않는다(창=컴포넌트
// 1:1, WorkspaceCanvas 가 key=win.id 로 마운트). useMemo([windowId]) 캐시·effect
// deps 생략이 이 불변식에 기댄다 — 창 재사용(id 교체) 최적화 금지.
export const WindowViewContext = createContext<WindowViewValue | null>(null);

/**
 * WindowView — 멀티창 워크스페이스의 창-스코프 뷰 컨텍스트 (ADR-0119, PR-B).
 *
 * 차트/데이터 소비자(useLiveBundle·LivePage·LiveChartRoot…)는 지금까지 활성 뷰의
 * (code, timeframe, historicalFromDate, 지표)를 전역 `useLivePageStore` 에서 직독했다.
 * 멀티창에서는 이 값들이 창마다 달라야 하므로, 소비자를 이 컨텍스트 훅으로 절단한다.
 *
 * **핵심 계약: Provider 밖에서는 전역 스토어로 폴백한다.** 따라서 이 절단 자체는
 * 기능 무변경이다 — 아직 어떤 창도 `WindowViewContext.Provider` 로 감싸지 않으므로
 * (그건 PR-C) 항상 전역 값을 본다. `/study` 도 Provider 없이 렌더되므로 무변경.
 * 창별 Provider 가 붙는 순간(PR-C) 같은 소비자가 창의 값을 보게 된다.
 *
 * 범위: 데이터 페치 경로만(code·timeframe·historicalFromDate·지표). 크로스헤어/축
 * 동기화는 PR-D, venue 는 전역 유지(#715), ambient 투영 원본 교체는 #712/PR-C.
 *
 * (컴포넌트를 export 하지 않는 `.ts` — Provider 는 컨텍스트를 직접 쓰는 쪽[테스트·
 * PR-C]에서 `<WindowViewContext.Provider>` 로 감싼다. react-refresh 규약상 훅·컨텍스트
 * 와 컴포넌트를 한 파일에 섞지 않는다.)
 */
import { createContext, useContext, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import { INDICATOR_SETTING_KEYS, type IndicatorSettings } from '../../state/indicatorSettingsV2';
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

export const WindowViewContext = createContext<WindowViewValue | null>(null);

/**
 * 창의 (code, timeframe, historicalFromDate, group). Provider 밖에서는 전역
 * `useLivePageStore` 로 폴백 → 기존 단일 뷰 동작 그대로.
 */
export function useWindowView(): WindowView {
  const ctx = useContext(WindowViewContext);
  const code = useLivePageStore((s) => s.activeCode);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const historicalFromDate = useLivePageStore((s) => s.historicalFromDate);
  return useMemo(
    () => ctx ?? { windowId: null, group: null, code, timeframe, historicalFromDate },
    [ctx, code, timeframe, historicalFromDate],
  );
}

/**
 * 창의 resolve 된 IndicatorSettings. Provider 밖에서는 전역 스토어의 ambient 투영
 * (=현재 봉으로 resolve 된 최상위 IndicatorSettings 필드)으로 폴백. `useShallow` 로
 * 필드 단위 얕은 비교 → 무관한 스토어 변경에 재렌더하지 않는다.
 */
export function useWindowIndicators(): IndicatorSettings {
  const ctx = useContext(WindowViewContext);
  const global = useLivePageStore(
    useShallow((s): IndicatorSettings => {
      const out: Partial<IndicatorSettings> = {};
      for (const k of INDICATOR_SETTING_KEYS) {
        (out as Record<string, unknown>)[k] = s[k];
      }
      return out as IndicatorSettings;
    }),
  );
  return ctx ? ctx.indicators : global;
}

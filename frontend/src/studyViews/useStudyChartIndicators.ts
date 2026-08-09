/**
 * `/study` 차트 창의 resolve 된 지표 설정 — **창 밖 소비자용** (#904).
 *
 * 창 안(=Provider 안)에서는 `useWindowIndicators()` 를 쓴다. 문제는 창 밖에서
 * 같은 값을 읽어야 하는 소비자가 셋 있다는 것이다:
 *
 * - 참조 번들 **쿼리 키** — 어떤 데이터를 받아올지 결정한다
 * - 비활성 탭 워밍 — 같은 판정을 백그라운드로 미리 돌린다
 * - vdist **데이터 창** — 차트 창이 아닌 다른 창의 렌더
 *
 * 셋이 전역(`live.indicators.v2`)을 계속 읽으면, 차트가 그리려는 지표와 페이지가
 * 받아온 데이터가 어긋나 **"켰는데 안 보임"** 이 난다(히트맵을 켜도 번들에 그
 * 데이터가 없다). 그래서 셋 다 차트 창을 본다 — 차트 창이 "이 페이지가 무엇을
 * 받고 무엇을 그릴지" 의 SSOT 다.
 *
 * 셀렉터를 세 곳에 복제하지 않는 이유도 같다: 갈라지는 순간 위 증상이 한쪽에서만
 * 재현되어 진단이 어려워진다.
 *
 * 창이 여러 개면(#801) "어느 창인가" 가 생긴다 — **포커스된 차트 창**이 답이다.
 * 탭 라벨·커서 해석·뷰포트 캡처와 같은 창을 따르므로 "지금 보고 있는 창" 이라는
 * 한 가지 의미로 통일된다.
 *
 * ⚠ 번들 쿼리는 이제 이 훅을 쓰지 않는다 — 창마다 지표가 다를 수 있어
 * `useStudyReferenceBundles` 가 **창별 지표**로 키를 만든다. 여기 남은 소비자는
 * 창 밖에서 "대표값" 하나면 되는 쪽(워밍 프리페치·vdist 데이터 창)이다.
 */
import { useMemo } from 'react';
import {
  FACTORY_INDICATOR_SETTINGS,
  resolveIndicatorSettings,
  type IndicatorSettings,
} from '../state/indicatorSettingsV2';
import { focusedChartWindowId, useStudyWorkspaceStore } from '../state/studyWorkspace';

export function useStudyChartIndicators(): IndicatorSettings {
  const chartConfig = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.id === focusedChartWindowId(s))?.chart,
  );
  return useMemo(
    () => (chartConfig
      ? resolveIndicatorSettings(chartConfig.indicators.byTimeframe, chartConfig.timeframe)
      : FACTORY_INDICATOR_SETTINGS),
    [chartConfig],
  );
}

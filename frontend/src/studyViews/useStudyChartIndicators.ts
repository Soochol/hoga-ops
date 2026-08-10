/**
 * `/study` 차트 창의 resolve 된 지표 설정 — **창 밖 소비자용** (#904).
 *
 * 창 안(=Provider 안)에서는 `useWindowIndicators()` 를 쓴다. 창 밖에서 같은 값을
 * 읽어야 하는 소비자가 둘 있다: **비활성 탭 워밍**(같은 판정을 백그라운드로 미리
 * 돌린다)과 **vdist 데이터 창**(차트 창이 아닌 다른 창의 렌더).
 *
 * 이들이 창과 다른 값을 보면 차트가 그리려는 지표와 페이지가 받아온 데이터가
 * 어긋나 **"켰는데 안 보임"** 이 난다(히트맵을 켜도 번들에 그 데이터가 없다).
 * 셀렉터를 두 곳에 복제하지 않는 이유도 같다 — 갈라지는 순간 그 증상이 한쪽에서만
 * 재현되어 진단이 어려워진다.
 *
 * 설정 자체는 이제 앱 전역 1세트(`live.indicators.v2`)라 "어느 창인가" 는
 * **봉에만** 남는다. 그 봉은 **포커스된 차트 창**의 것이다(#801) — 탭 라벨·커서
 * 해석·뷰포트 캡처와 같은 창을 따르므로 "지금 보고 있는 창" 이라는 한 가지 의미로
 * 통일된다.
 *
 * ⚠ 번들 쿼리는 이 훅을 쓰지 않는다 — 창마다 봉이 달라 유효 지표도 달라지므로
 * `useStudyReferenceBundles` 가 **창별**로 키를 만든다(StudyPage).
 */
import {
  resolveIndicatorSettings,
  type IndicatorSettings,
} from '../state/indicatorSettingsV2';
import { useLivePageStore } from '../state/livePage';
import { STUDY_DEFAULT_MINUTE_TIMEFRAME } from '../state/studyLastMinuteTimeframe';
import { focusedChartWindowId, useStudyWorkspaceStore } from '../state/studyWorkspace';

export function useStudyChartIndicators(): IndicatorSettings {
  // 설정은 전역, 봉은 포커스 창 — 창이 정하는 것은 "어느 버킷인가" 뿐이다.
  const timeframe = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.id === focusedChartWindowId(s))?.chart?.timeframe
      ?? STUDY_DEFAULT_MINUTE_TIMEFRAME,
  );
  return useLivePageStore((s) => resolveIndicatorSettings(s.indicatorsByTimeframe, timeframe));
}

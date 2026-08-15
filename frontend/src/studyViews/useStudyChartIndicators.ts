/**
 * `/study` 차트 창의 resolve 된 지표 설정 — **창 밖 소비자용** (#904).
 *
 * 창 안(=Provider 안)에서는 `useWindowIndicators()` 를 쓴다. 창 밖에서 같은 값을
 * 읽어야 하는 소비자는 **vdist 데이터 창** 하나다 — 차트 창이 아닌 다른 창의 렌더라
 * Provider 밖인데, 커서를 주는 창과 같은 지표를 봐야 한다. 그 창이 곧 포커스 창이므로
 * "포커스 창의 봉" 이 정확히 원하는 의미다.
 *
 * 이것이 창과 다른 값을 보면 차트가 그리려는 지표와 페이지가 받아온 데이터가
 * 어긋나 **"켰는데 안 보임"** 이 난다(히트맵을 켜도 번들에 그 데이터가 없다).
 *
 * ⚠ **비활성 탭 워밍은 이 훅을 쓰면 안 된다** — 한때 썼다가 사고가 났다. 워밍 쿼리의
 * `bucket_ms` 는 **그 탭의 봉**인데 이 훅은 **포커스 창의 봉**으로 지표를 푼다. 포커스가
 * D 이고 워밍 대상이 분봉이면 "분봉 버킷 + D 프로필 지표" 라는 잡종 키가 나가고,
 * 활성 전환에서 키가 안 맞아 같은 구간을 플래그만 바꿔 한 번 더 받는다 — 워밍이
 * 요청을 줄이려다 늘린다. 지금은 탭마다 자기 봉으로 푼다
 * (`useWarmStudyReferenceTabQueries` → `studyReferenceQuerySettings`).
 *
 * 지표 세트는 페이지 것이므로(ADR-0146) 여기서 창에 묻는 것은 **봉뿐**이다. 그 봉은
 * **포커스된 차트 창**의 것이다(#801) — 탭 라벨·커서 해석·뷰포트 캡처와 같은 창을
 * 따르므로 "지금 보고 있는 창" 이라는 한 가지 의미로 통일된다.
 *
 * ⚠ 번들 쿼리는 이 훅을 쓰지 않는다 — 창마다 봉이 달라 유효 지표도 달라지므로
 * `useStudyReferenceBundles` 가 **창별**로 키를 만든다(StudyPage).
 */
import {
  bucketsForPage,
  resolveIndicatorSettings,
  type IndicatorSettings,
} from '../state/indicatorSettingsV2';
import { useLivePageStore } from '../state/livePage';
import { STUDY_DEFAULT_MINUTE_TIMEFRAME } from '../state/studyLastMinuteTimeframe';
import { focusedChartWindowId, useStudyWorkspaceStore } from '../state/studyWorkspace';

export function useStudyChartIndicators(): IndicatorSettings {
  const timeframe = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.id === focusedChartWindowId(s))?.chart?.timeframe
      ?? STUDY_DEFAULT_MINUTE_TIMEFRAME,
  );
  return useLivePageStore((s) => resolveIndicatorSettings(
    bucketsForPage(s.indicatorsByTimeframe, s.studyIndicatorsByTimeframe, 'study'),
    timeframe,
  ));
}

import { useScopedChartPrefs } from '../../state/chartPrefs';
import {
  peakWallFamilyToggleKeys,
  type PeakWallFamilyId,
} from '../../state/peakWallFamilyPrefs';
import { useWindowScopeId } from '../workspace/windowView';
import {
  usePeakWallCountsRegistry,
  peakWallCountsKey,
  type PeakWallCounts,
} from './peakWallCountsRegistry';
import { scopeEntries } from './windowScopedRegistry';

/**
 * 한 칸(방향×계열)의 **후보 필터 상태** — 몇 개가 걸려 있고, 지금 몇 개가 그려지나.
 *
 * ## 두 값의 출처가 다르다 (의도)
 *
 * - `activeFilterCount` 는 **pref 만** 읽는다. "이 칸에 필터가 몇 개 켜져 있나" 는
 *   차트를 볼 필요가 없다 — 스위치가 곧 답이다.
 * - `counts` 는 **차트가 발행한 것**을 읽는다. "그래서 몇 개가 남았나" 는 그날의
 *   데이터를 봐야 알 수 있고, 그 계산은 렌더 경로 안에서만 존재한다.
 *
 * ## 극성 주의 — 기본이 최대다
 *
 * 필터 둘의 공장값이 **둘 다 켜짐**이라, 손대지 않은 칸은 `activeFilterCount === 2`
 * 로 시작한다. "필터를 걸수록 숫자가 커진다" 가 아니라 "기본이 최대" 라는 뜻이므로
 * 문구를 그렇게 읽히게 쓸 것. (이게 「당일 최대벽이 왜 안 보이나」의 실제 원인이었다.)
 *
 * `intraMax` 는 세지 않는다 — 그건 필터가 아니라 **소스 선택자**라(close 축 ↔ max 축)
 * 후보를 줄이지 않는다.
 */
export function usePeakWallFilterState(side: 'ask' | 'bid', family: PeakWallFamilyId): {
  activeFilterCount: number;
  /** `undefined` = 차트가 아직/아예 발행하지 않았다(일·주·월봉 등). **0 이 아니다.** */
  counts: PeakWallCounts | undefined;
} {
  const prefs = useScopedChartPrefs();
  const scope = useWindowScopeId();
  const byScope = usePeakWallCountsRegistry((s) => s.byScope);

  const activeFilterCount = peakWallFamilyToggleKeys(side, family, 'filter')
    .filter((key) => prefs[key]).length;

  return {
    activeFilterCount,
    counts: scopeEntries(byScope, scope).get(peakWallCountsKey(side, family)),
  };
}

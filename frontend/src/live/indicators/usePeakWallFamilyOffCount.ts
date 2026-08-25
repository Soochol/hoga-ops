import { useScopedChartPrefs } from '../../state/chartPrefs';
import {
  peakWallFamilyToggleKeys,
  type PeakWallFamilyId,
} from '../../state/peakWallFamilyPrefs';

/**
 * 그 계열에서 **꺼 둔** 세부 토글 개수 — 접힌 카드의 뱃지 숫자.
 *
 * 다섯이 전부 기본 `true` 라 "끈 개수" 가 곧 "기본값에서 벗어난 정도" 다. MA **기간**은
 * 세지 않는다: 기간은 필터가 켜져 있을 때만 의미가 있고, 그 필터가 켜져 있다는 것은
 * 이미 기본 상태라 뱃지가 붙지 않는 쪽이 맞다(뱃지의 뜻은 "여기 뭔가 꺼져 있다").
 */
export function usePeakWallFamilyOffCount(
  side: 'ask' | 'bid',
  family: PeakWallFamilyId,
): number {
  const prefs = useScopedChartPrefs();
  const keys = [
    ...peakWallFamilyToggleKeys(side, family, 'surface'),
    ...peakWallFamilyToggleKeys(side, family, 'filter'),
  ];
  return keys.filter((key) => !prefs[key]).length;
}

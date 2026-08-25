import {
  peakWallFamilyToggleKeys,
  type PeakWallFamilyId,
} from '../../state/peakWallFamilyPrefs';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { PeakWallSectionHead } from './PeakWallFamilyCard';

type Props = {
  side: 'ask' | 'bid';
  family: PeakWallFamilyId;
};

/**
 * 한 계열의 「세부 설정」 — 표면 셋(라벨 · 레전드 순위 셀 · 상위벽 순위 화살표)과 후보
 * 기준 둘(분봉 MA · 일봉 MA). MA 기간은 레지스트리의 `enabledBy` 로 각 토글 아래에
 * 따라붙는다 — 여기서 손으로 배치하지 않는다.
 *
 * ## 왜 계열 카드 **안**인가
 *
 * 2026-08-25 이전엔 이 일곱이 방향당 한 벌뿐이라 카드 **밖**에 있었고, 그 위치가 곧
 * "세 계열 공통" 이라는 뜻이었다. 이제 계열마다 따로 사니 위치도 따라 들어와야 한다 —
 * 카드 밖에 남으면 화면이 여전히 "공통" 이라고 말하는 셈이다(이 패널의 배치 규칙:
 * 안에 있으면 그 계열, 밖에 있으면 공통).
 *
 * 카드 밖 「후보 기준」에 남은 것은 `*PeakIntraMax` 하나뿐이고, 그건 **의도적 공용**이다.
 */
export default function PeakWallFamilyDetails({ side, family }: Props) {
  return (
    <div
      data-testid={`peak-wall-family-details-${side}-${family}`}
      className="rounded-md border border-dashed border-border px-2 pb-1.5"
    >
      <PeakWallSectionHead>어디에</PeakWallSectionHead>
      <IndicatorPrefRows toggleKeys={peakWallFamilyToggleKeys(side, family, 'surface')} />
      <PeakWallSectionHead>후보 기준</PeakWallSectionHead>
      <IndicatorPrefRows toggleKeys={peakWallFamilyToggleKeys(side, family, 'filter')} />
    </div>
  );
}

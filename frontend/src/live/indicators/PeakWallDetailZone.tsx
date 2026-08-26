import {
  PEAK_WALL_FAMILIES,
  peakWallFamilyToggleKeys,
  type PeakWallFamilyId,
} from '../../state/peakWallFamilyPrefs';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { useWindowIndicator } from '../workspace/windowView';
import { usePeakWallFilterState } from './usePeakWallFilterState';

/** 계열 선 토글의 상태 키 — 리드아웃이 "이 계열이 켜져 있나" 를 물을 때 쓴다. */
const PEAK_LINE_KEY = {
  ask: {
    Traded: 'askPeakTradedLineEnabled',
    Unreached: 'askPeakUnreachedLineEnabled',
    AllWall: 'askPeakAllWallLineEnabled',
  },
  bid: {
    Traded: 'bidPeakTradedLineEnabled',
    Unreached: 'bidPeakUnreachedLineEnabled',
    AllWall: 'bidPeakAllWallLineEnabled',
  },
} as const;

/**
 * 매트릭스에서 고른 **한 칸(방향 × 계열)**의 세부 — 표면 다섯과 후보 기준 둘.
 *
 * ## 왜 존이 하나인가
 *
 * 종전엔 계열 카드 셋이 각자 접히는 「세부 설정」을 품었다. 전부 펼치면 3계열 ×
 * 7행 = 21행이라 「어떤 벽」 구획이 화면 밖으로 밀렸고, 그래서 기본 접힘이었고,
 * 접혀 있으니 **거기 뭐가 꺼져 있는지 보이지 않아** 뱃지를 따로 달아야 했다.
 *
 * 매트릭스는 선택이 항상 하나라 존도 하나면 된다 — 7행이 상시 펼쳐진 채 화면에
 * 있고, 접기·뱃지가 둘 다 필요 없어진다.
 *
 * ## 라벨과 기간은 여기서 적지 않는다
 *
 * `IndicatorPrefRows` 에 키만 넘기면 레지스트리가 라벨·설명·기본값을 그리고,
 * MA 기간 입력은 `enabledBy` 로 각 필터 토글 **아래에 자동으로 따라붙는다**.
 * 손으로 배치하면 레지스트리와 갈린다.
 */
/**
 * 「지금 N개 표시 · M개 필터로 숨김」 — 이 존의 설정이 **실제로 무엇을 하고 있는지**.
 *
 * ## 언제 뜨지 않는가 (셋 다 이유가 다르다)
 *
 * - **계열이 꺼져 있으면**: 개수가 0인 게 당연하다. 그 0을 보여 주면 "필터가 다
 *   걸렀다" 와 구별되지 않는다 — 애초에 안 그리기로 한 것이다.
 * - **엔트리가 없으면**: 차트가 발행하지 않았다는 뜻이다(일·주·월봉은 이 지표가
 *   적용되지 않는다). 부재가 신호이므로 0으로 대체하지 않는다.
 * - **눈이 꺼져 있으면**: 문구를 바꾼다. 세그먼트 계산은 눈(hidden)을 보지 않으므로
 *   (`usePeakWallRender` 의 불변식) "표시" 라고 쓰면 거짓말이 된다 — 세어 둔 것은
 *   후보이지 화면에 있는 것이 아니다.
 *
 * ## 합이 총수가 아니다
 *
 * `N + M ≠ 후보 총수` 가 정상이다 — 필터 뒤에 세그먼트 매핑에서 더 빠지는 것이
 * 있다(`buildPeakWallOverlayResult` 참조). 그래서 총수를 주장하지 않는다.
 */
function PeakWallReadout({
  side, family,
}: {
  side: 'ask' | 'bid';
  family: PeakWallFamilyId;
}) {
  const { counts } = usePeakWallFilterState(side, family);
  const lineEnabled = useWindowIndicator((s) => s[PEAK_LINE_KEY[side][family]]);
  const hidden = useWindowIndicator((s) => (side === 'ask' ? s.askPeakHidden : s.bidPeakHidden));
  const sideEnabled = useWindowIndicator((s) => (side === 'ask' ? s.askPeakEnabled : s.bidPeakEnabled));

  if (!sideEnabled || !lineEnabled || counts === undefined) return null;

  const alarming = counts.shown === 0 && counts.hiddenByFilter > 0;
  const text = hidden
    ? `수평선 숨김 — 후보 ${counts.shown}개 · ${counts.hiddenByFilter}개 필터로 제외`
    : `지금 ${counts.shown}개 표시 · ${counts.hiddenByFilter}개 필터로 숨김`;

  return (
    <span
      data-testid={`peak-wall-readout-${side}-${family}`}
      className={`shrink-0 rounded-full px-2 py-0.5 text-2xs tabular-nums ${
        alarming ? 'bg-tint-warn text-warn' : 'bg-tint-neutral text-fg-dim'
      }`}
    >
      {text}
    </span>
  );
}

export default function PeakWallDetailZone({
  side,
  family,
}: {
  side: 'ask' | 'bid';
  family: PeakWallFamilyId;
}) {
  const familyLabel = PEAK_WALL_FAMILIES.find((f) => f.id === family)?.name ?? family;
  const sideLabel = side === 'ask' ? '매도' : '매수';

  return (
    <div
      data-testid={`peak-wall-detail-zone-${side}-${family}`}
      className="mt-3 rounded-lg bg-bg-subtle px-3.5 pb-2 pt-2.5"
    >
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <span className="text-sm font-semibold text-fg">
          {sideLabel} · {familyLabel}
        </span>
        <PeakWallReadout side={side} family={family} />
      </div>

      <div className="mt-1 text-2xs font-semibold uppercase text-fg-dim">어디에</div>
      <IndicatorPrefRows toggleKeys={peakWallFamilyToggleKeys(side, family, 'surface')} />

      <div className="mt-3 text-2xs font-semibold uppercase text-fg-dim">후보 기준</div>
      <IndicatorPrefRows toggleKeys={peakWallFamilyToggleKeys(side, family, 'filter')} />
      {/* 두 필터가 순차 적용이라 교집합이라는 사실이 화면에 없으면, 하나만 풀고서
          "왜 아직도 안 보이지" 가 된다. */}
      <p className="py-2 text-2xs text-fg-dim">
        두 기준은 교집합으로 걸립니다 — 둘 다 통과한 벽만 그려집니다.
      </p>
    </div>
  );
}

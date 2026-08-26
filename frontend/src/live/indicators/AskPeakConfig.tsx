import { useScopedChartPrefs, useChartPrefActions } from '../../state/chartPrefs';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';
import PeakWallFamilyDetails from './PeakWallFamilyDetails';
import { usePeakWallFamilyOffCount } from './usePeakWallFamilyOffCount';
import PeakWallFamilyCard, {
  PeakWallRankSelect,
  PeakWallSectionHead,
} from './PeakWallFamilyCard';

/**
 * 당일 매도 최대벽 상세 설정 — **계열이 곧 단위**(2026-08-25 재구성 → 계열별 분리).
 *
 * ## 어떻게 여기까지 왔나
 *
 * 종전엔 컨트롤 14개가 한 줄로 늘어서 네 가지 질문이 섞여 있었다: 어떤 벽을 그릴까
 * (계열) · 어디에 그릴까(표면) · 무엇을 후보로 볼까(필터) · 어떻게 보일까(장식).
 * 1차 재구성이 그 축을 네 구획으로 갈랐다.
 *
 * 그런데 구획이 갈리고 나니 **스코프가 어긋나 있다는 것**이 보였다. 계열은 셋인데
 * 「어디에」와 「후보 기준」은 방향당 한 벌이라, "체결된 벽만 라벨을 붙이고 미도달 벽은
 * 선만" 이나 "전체 최대벽에만 일봉 MA 필터" 같은 조합이 **원리적으로 불가능**했다.
 *
 * ## 지금의 배치 규칙
 *
 * **위치가 스코프를 말한다.** 계열 카드 안에 있으면 그 계열의 것이고, 밖에 있으면 공통이다.
 *
 * - **카드 안** — 마스터 토글 · 선 스타일 · 표시 개수 · 그리고 접히는 「세부 설정」
 *   (표면 셋 + MA 필터 둘 + 각 기간). 일곱 축이 계열마다 한 벌씩이다.
 * - **카드 밖** — 「계열 공용」 구획의 `askPeakIntraMax` 하나. 미도달 계열은 carrier 가
 *   양쪽 같은 값이라 이 토글이 애초에 무효라(`usePeakWallRender` 머리말), 계열별로 두면
 *   셋 중 하나가 아무 일도 하지 않는 스위치가 된다.
 * - **탭 밖** — 방향 공용인 「최대벽 강도 pane」은 이 컴포넌트가 아니라 `PeakWallsConfig`.
 *
 * 세부 설정이 기본 접힘인 이유: 펼친 채로 두면 계열 3장 × 7행이라 「어떤 벽」 구획이
 * 화면 밖으로 밀린다. 접힌 채로도 "여기 뭔가 꺼져 있다" 가 보이도록 카드가 **끈 개수**를
 * 뱃지로 문다(`usePeakWallFamilyOffCount`).
 *
 * 제목·설명은 이 컴포넌트가 갖지 않는다 — 카테고리 표(`CATEGORIES`)가 패널 헤더에서
 * 말한다. 종전의 `embedded` prop 은 그 이관으로 분기할 것이 없어져 사라졌다.
 */
export default function AskPeakConfig() {
  const actions = useIndicatorActions();
  const tradedEnabled = useWindowIndicator((s) => s.askPeakTradedLineEnabled);
  const color = useWindowIndicator((s) => s.askPeakColor);
  const lineWidth = useWindowIndicator((s) => s.askPeakLineWidth);
  const unreachedEnabled = useWindowIndicator((s) => s.askPeakUnreachedLineEnabled);
  const unreachedColor = useWindowIndicator((s) => s.askPeakUnreachedColor);
  const unreachedLineWidth = useWindowIndicator((s) => s.askPeakUnreachedLineWidth);
  const allWallEnabled = useWindowIndicator((s) => s.askPeakAllWallLineEnabled);
  const allWallColor = useWindowIndicator((s) => s.askPeakAllWallColor);
  const allWallLineWidth = useWindowIndicator((s) => s.askPeakAllWallLineWidth);
  const prefs = useScopedChartPrefs();
  const tradedRankLimit = prefs.askPeakAllPriceRankLimit;
  const allWallRankLimit = prefs.askPeakAllWallRankLimit;
  const unreachedRankLimit = prefs.askPeakUnreachedRankLimit;
  const { setNumericPref } = useChartPrefActions();
  // 접힌 카드의 뱃지 — 그 계열에서 꺼 둔 세부 항목 개수.
  const tradedOffCount = usePeakWallFamilyOffCount('ask', 'Traded');
  const unreachedOffCount = usePeakWallFamilyOffCount('ask', 'Unreached');
  const allWallOffCount = usePeakWallFamilyOffCount('ask', 'AllWall');

  return (
    <div>
      {/* ── 어떤 벽 ─────────────────────────────────────────────────
          순서는 체결 → 미도달 → 전체. 앞 둘은 **배타적**이고(체결됐다면 당일 고가가
          그 가격에 닿았다는 뜻이라 미도달일 수 없다) 전체는 그 둘과 사이 구간까지
          포함한 상위집합이라, 이 순서로 읽으면 설명 세 줄이 포함 관계를 만든다. */}
      <PeakWallSectionHead>어떤 벽</PeakWallSectionHead>
      <PeakWallFamilyCard
        name="체결된 벽"
        description="그 벽이 서 있던 1분 안에 체결이 그 가격을 쳤다"
        color={color}
        lineWidth={lineWidth}
        onStyleChange={actions.setAskPeakStyle}
        enabled={tradedEnabled}
        onToggle={() => actions.setAskPeakTradedLineEnabled(!tradedEnabled)}
        testId="settings-toggle-askPeakTradedLineEnabled"
        extra={(
          <PeakWallRankSelect
            familyName="체결된 벽"
            value={tradedRankLimit}
            onChange={(n) => setNumericPref('askPeakAllPriceRankLimit', n)}
          />
        )}
        detailsOffCount={tradedOffCount}
        details={<PeakWallFamilyDetails side="ask" family="Traded" />}
      />
      <PeakWallFamilyCard
        name="미도달 벽"
        description="당일 고가가 아직 그 가격에 닿지 않았다 — 위와 배타"
        color={unreachedColor}
        lineWidth={unreachedLineWidth}
        onStyleChange={actions.setAskPeakUnreachedStyle}
        enabled={unreachedEnabled}
        onToggle={() => actions.setAskPeakUnreachedLineEnabled(!unreachedEnabled)}
        testId="settings-toggle-askPeakUnreachedLineEnabled"
        extra={(
          <PeakWallRankSelect
            familyName="미도달 벽"
            value={unreachedRankLimit}
            onChange={(n) => setNumericPref('askPeakUnreachedRankLimit', n)}
          />
        )}
        detailsOffCount={unreachedOffCount}
        details={<PeakWallFamilyDetails side="ask" family="Unreached" />}
      />
      <PeakWallFamilyCard
        name="전체 최대벽"
        description="터치 무관 — 위 둘과 그 사이까지 포함한 그날 최대"
        color={allWallColor}
        lineWidth={allWallLineWidth}
        onStyleChange={actions.setAskPeakAllWallStyle}
        enabled={allWallEnabled}
        onToggle={() => actions.setAskPeakAllWallLineEnabled(!allWallEnabled)}
        testId="settings-toggle-askPeakAllWallLineEnabled"
        extra={(
          <PeakWallRankSelect
            familyName="전체 최대벽"
            value={allWallRankLimit}
            onChange={(n) => setNumericPref('askPeakAllWallRankLimit', n)}
          />
        )}
        detailsOffCount={allWallOffCount}
        details={<PeakWallFamilyDetails side="ask" family="AllWall" />}
      />

      {/* ── 계열 공용 ───────────────────────────────────────────────
          여기 남은 것은 **세 계열이 하나를 공유하는** 노브뿐이다. 표면 셋(라벨·레전드 셀·
          화살표)과 MA 필터 둘은 계열마다 갈렸으므로 각 카드의 「세부 설정」 안으로 들어갔다
          — 위치가 스코프를 말한다. `intraMax` 가 공용으로 남은 이유: 미도달 계열은 carrier
          가 양쪽 같은 값이라 이 토글이 애초에 무효라(`usePeakWallRender` 머리말), 계열별로
          두면 셋 중 하나가 아무 일도 하지 않는 스위치가 되어 화면의 대칭이 거짓말을 한다. */}
      <PeakWallSectionHead>계열 공용</PeakWallSectionHead>
      <IndicatorPrefRows toggleKeys={['askPeakIntraMax']} />
    </div>
  );
}

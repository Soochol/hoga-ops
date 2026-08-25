import { useScopedChartPrefs, useChartPrefActions } from '../../state/chartPrefs';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';
import PeakWallFamilyCard, {
  PeakWallRankSelect,
  PeakWallSectionHead,
} from './PeakWallFamilyCard';

/**
 * 당일 매도 최대벽 상세 설정 — **축별 4구획**(2026-08-25 재구성).
 *
 * 종전엔 컨트롤 14개가 한 줄로 늘어서 네 가지 질문이 섞여 있었다: 어떤 벽을 그릴까
 * (계열) · 어디에 그릴까(표면) · 무엇을 후보로 볼까(필터) · 어떻게 보일까(장식).
 * 표면 스위치는 위(캔들 수평선)와 아래(라벨·화살표)로 쪼개져 있었고, 계열에만
 * 해당하는 노브(「체결된 벽 표시 개수」)는 맨 아래에 떨어져 있었다.
 *
 * 이제 축이 곧 구획이다. 계열은 카드가 되어 자기 스타일과 자기 전용 노브를 안에
 * 갖고, 표면 넷은 한곳에 모이고, 「후보 기준」에는 계산에 영향을 주는 것만 남는다.
 * (방향 공용인 「최대벽 강도 pane」은 이 컴포넌트가 아니라 **방향 탭 밖**에 있다 —
 * `PeakWallsConfig`. 공용이라는 사실을 위치로 말한다.)
 *
 * `embedded` — 병합된 「당일 최대벽」 서브탭 안에서 제목·설명을 숨긴다(상위가 표시).
 */
export default function AskPeakConfig({ embedded = false }: { embedded?: boolean } = {}) {
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

  return (
    <div>
      {!embedded && (
        <>
          <h3 className="text-fg text-base font-medium pb-1">
            당일 매도 최대벽 <span aria-hidden="true" className="text-fg-dim text-sm">ⓘ</span>
          </h3>
          <p className="text-fg-dim text-xs mb-3">
            차트에 보이는 거래일마다, 그 날 매도 10호가 중 한 단계에 가장 크게 걸렸던 물량의
            가격에 그날 구간만큼 수평선을 그립니다. 분봉 차트에서만 표시됩니다
          </p>
        </>
      )}

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
      />

      {/* ── 어디에 ─────────────────────────────────────────────────
          위에서 켠 계열들이 **어느 표면에** 나오는가. 종전엔 캔들 수평선만 위쪽
          「표시 위치」에 있고 라벨·화살표는 필터들 사이에 섞여 있었다. */}
      <PeakWallSectionHead>어디에</PeakWallSectionHead>
      <IndicatorPrefRows
        toggleKeys={['askPeakLabelEnabled', 'askPeakRankArrowEnabled', 'askPeakLegendCellEnabled']}
      />

      {/* ── 후보 기준 ───────────────────────────────────────────────
          계산에 영향을 주는 것만. MA 기간은 레지스트리의 `enabledBy` 로 각 토글
          아래에 따라붙는다 — 여기서 손으로 배치하지 않는다. */}
      <PeakWallSectionHead>후보 기준</PeakWallSectionHead>
      <IndicatorPrefRows
        toggleKeys={['askPeakIntraMax', 'askPeakAboveMaEnabled', 'askPeakAboveDailyMaEnabled']}
      />
    </div>
  );
}

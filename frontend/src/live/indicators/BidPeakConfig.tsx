import { useScopedChartPrefs, useChartPrefActions } from '../../state/chartPrefs';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';
import PeakWallFamilyCard, {
  PeakWallRankSelect,
  PeakWallSectionHead,
} from './PeakWallFamilyCard';

/**
 * 당일 매수 최대벽 상세 설정 — 매도판(`AskPeakConfig`)의 대칭 미러.
 *
 * 구조·근거는 그쪽 주석을 볼 것. 방향으로 갈리는 것은 미도달 판정의 기준(고가↔저가)과
 * MA 필터 방향(위↔아래)뿐이다.
 *
 * `embedded` — 병합된 「당일 최대벽」 서브탭 안에서 제목·설명을 숨긴다(상위가 표시).
 */
export default function BidPeakConfig({ embedded = false }: { embedded?: boolean } = {}) {
  const actions = useIndicatorActions();
  const tradedEnabled = useWindowIndicator((s) => s.bidPeakTradedLineEnabled);
  const color = useWindowIndicator((s) => s.bidPeakColor);
  const lineWidth = useWindowIndicator((s) => s.bidPeakLineWidth);
  const unreachedEnabled = useWindowIndicator((s) => s.bidPeakUnreachedLineEnabled);
  const unreachedColor = useWindowIndicator((s) => s.bidPeakUnreachedColor);
  const unreachedLineWidth = useWindowIndicator((s) => s.bidPeakUnreachedLineWidth);
  const allWallEnabled = useWindowIndicator((s) => s.bidPeakAllWallLineEnabled);
  const allWallColor = useWindowIndicator((s) => s.bidPeakAllWallColor);
  const allWallLineWidth = useWindowIndicator((s) => s.bidPeakAllWallLineWidth);
  const prefs = useScopedChartPrefs();
  const tradedRankLimit = prefs.bidPeakAllPriceRankLimit;
  const allWallRankLimit = prefs.bidPeakAllWallRankLimit;
  const unreachedRankLimit = prefs.bidPeakUnreachedRankLimit;
  const { setNumericPref } = useChartPrefActions();

  return (
    <div>
      {!embedded && (
        <>
          <h3 className="text-fg text-base font-medium pb-1">
            당일 매수 최대벽 <span aria-hidden="true" className="text-fg-dim text-sm">ⓘ</span>
          </h3>
          <p className="text-fg-dim text-xs mb-3">
            차트에 보이는 거래일마다, 그 날 매수 10호가 중 한 단계에 가장 크게 걸렸던 물량의
            가격에 그날 구간만큼 수평선을 그립니다. 분봉 차트에서만 표시됩니다
          </p>
        </>
      )}

      {/* ── 어떤 벽 ─────────────────────────────────────────────────
          순서는 체결 → 미도달 → 전체. 앞 둘은 **배타적**이고(체결됐다면 당일 저가가
          그 가격에 닿았다는 뜻이라 미도달일 수 없다) 전체는 그 둘과 사이 구간까지
          포함한 상위집합이라, 이 순서로 읽으면 설명 세 줄이 포함 관계를 만든다. */}
      <PeakWallSectionHead>어떤 벽</PeakWallSectionHead>
      <PeakWallFamilyCard
        name="체결된 벽"
        description="그 벽이 서 있던 1분 안에 체결이 그 가격을 쳤다"
        color={color}
        lineWidth={lineWidth}
        onStyleChange={actions.setBidPeakStyle}
        enabled={tradedEnabled}
        onToggle={() => actions.setBidPeakTradedLineEnabled(!tradedEnabled)}
        testId="settings-toggle-bidPeakTradedLineEnabled"
        extra={(
          <PeakWallRankSelect
            familyName="체결된 벽"
            value={tradedRankLimit}
            onChange={(n) => setNumericPref('bidPeakAllPriceRankLimit', n)}
          />
        )}
      />
      <PeakWallFamilyCard
        name="미도달 벽"
        description="당일 저가가 아직 그 가격에 닿지 않았다 — 위와 배타"
        color={unreachedColor}
        lineWidth={unreachedLineWidth}
        onStyleChange={actions.setBidPeakUnreachedStyle}
        enabled={unreachedEnabled}
        onToggle={() => actions.setBidPeakUnreachedLineEnabled(!unreachedEnabled)}
        testId="settings-toggle-bidPeakUnreachedLineEnabled"
        extra={(
          <PeakWallRankSelect
            familyName="미도달 벽"
            value={unreachedRankLimit}
            onChange={(n) => setNumericPref('bidPeakUnreachedRankLimit', n)}
          />
        )}
      />
      <PeakWallFamilyCard
        name="전체 최대벽"
        description="터치 무관 — 위 둘과 그 사이까지 포함한 그날 최대"
        color={allWallColor}
        lineWidth={allWallLineWidth}
        onStyleChange={actions.setBidPeakAllWallStyle}
        enabled={allWallEnabled}
        onToggle={() => actions.setBidPeakAllWallLineEnabled(!allWallEnabled)}
        testId="settings-toggle-bidPeakAllWallLineEnabled"
        extra={(
          <PeakWallRankSelect
            familyName="전체 최대벽"
            value={allWallRankLimit}
            onChange={(n) => setNumericPref('bidPeakAllWallRankLimit', n)}
          />
        )}
      />

      {/* ── 어디에 ─────────────────────────────────────────────────
          위에서 켠 계열들이 **어느 표면에** 나오는가. 종전엔 캔들 수평선만 위쪽
          「표시 위치」에 있고 라벨·화살표는 필터들 사이에 섞여 있었다. */}
      <PeakWallSectionHead>어디에</PeakWallSectionHead>
      <IndicatorPrefRows
        toggleKeys={['bidPeakLabelEnabled', 'bidPeakRankArrowEnabled', 'bidPeakLegendCellEnabled']}
      />

      {/* ── 후보 기준 ───────────────────────────────────────────────
          계산에 영향을 주는 것만. MA 기간은 레지스트리의 `enabledBy` 로 각 토글
          아래에 따라붙는다 — 여기서 손으로 배치하지 않는다. */}
      <PeakWallSectionHead>후보 기준</PeakWallSectionHead>
      <IndicatorPrefRows
        toggleKeys={['bidPeakIntraMax', 'bidPeakBelowMaEnabled', 'bidPeakBelowDailyMaEnabled']}
      />
    </div>
  );
}

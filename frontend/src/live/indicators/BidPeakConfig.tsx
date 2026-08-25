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
  // 접힌 카드의 뱃지 — 그 계열에서 꺼 둔 세부 항목 개수.
  const tradedOffCount = usePeakWallFamilyOffCount('bid', 'Traded');
  const unreachedOffCount = usePeakWallFamilyOffCount('bid', 'Unreached');
  const allWallOffCount = usePeakWallFamilyOffCount('bid', 'AllWall');

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
        detailsOffCount={tradedOffCount}
        details={<PeakWallFamilyDetails side="bid" family="Traded" />}
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
        detailsOffCount={unreachedOffCount}
        details={<PeakWallFamilyDetails side="bid" family="Unreached" />}
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
        detailsOffCount={allWallOffCount}
        details={<PeakWallFamilyDetails side="bid" family="AllWall" />}
      />

      {/* ── 계열 공용 ───────────────────────────────────────────────
          여기 남은 것은 **세 계열이 하나를 공유하는** 노브뿐이다. 표면 셋(라벨·레전드 셀·
          화살표)과 MA 필터 둘은 계열마다 갈렸으므로 각 카드의 「세부 설정」 안으로 들어갔다
          — 위치가 스코프를 말한다. `intraMax` 가 공용으로 남은 이유: 미도달 계열은 carrier
          가 양쪽 같은 값이라 이 토글이 애초에 무효라(`usePeakWallRender` 머리말), 계열별로
          두면 셋 중 하나가 아무 일도 하지 않는 스위치가 되어 화면의 대칭이 거짓말을 한다. */}
      <PeakWallSectionHead>계열 공용</PeakWallSectionHead>
      <IndicatorPrefRows toggleKeys={['bidPeakIntraMax']} />
    </div>
  );
}

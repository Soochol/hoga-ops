import { useScopedChartPrefs, useChartPrefActions } from '../../state/chartPrefs';
import MAStylePicker from './MAStylePicker';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import ToggleRow from '../settings/ToggleRow';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

const RANK_OPTIONS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
] as const;

/** `embedded` — 병합된 「당일 최대벽」 페이지의 서브탭 안에서 렌더될 때 제목·설명을
 *  숨긴다(상위가 이미 표시). 단독 카테고리로 쓰이던 시절과의 호환을 위해 기본 false. */
export default function BidPeakConfig({ embedded = false }: { embedded?: boolean } = {}) {
  const color = useWindowIndicator((s) => s.bidPeakColor);
  const lineWidth = useWindowIndicator((s) => s.bidPeakLineWidth);
  const setStyle = useIndicatorActions().setBidPeakStyle;
  const allWallEnabled = useWindowIndicator((s) => s.bidPeakAllWallLineEnabled);
  const allWallColor = useWindowIndicator((s) => s.bidPeakAllWallColor);
  const allWallLineWidth = useWindowIndicator((s) => s.bidPeakAllWallLineWidth);
  const setAllWallEnabled = useIndicatorActions().setBidPeakAllWallLineEnabled;
  const setAllWallStyle = useIndicatorActions().setBidPeakAllWallStyle;
  const unreachedEnabled = useWindowIndicator((s) => s.bidPeakUnreachedLineEnabled);
  const unreachedColor = useWindowIndicator((s) => s.bidPeakUnreachedColor);
  const unreachedLineWidth = useWindowIndicator((s) => s.bidPeakUnreachedLineWidth);
  const setUnreachedEnabled = useIndicatorActions().setBidPeakUnreachedLineEnabled;
  const setUnreachedStyle = useIndicatorActions().setBidPeakUnreachedStyle;
  const prefs = useScopedChartPrefs();
  const postTouchRankLimit = prefs.bidPeakAllPriceRankLimit;
  const { setNumericPref } = useChartPrefActions();
  return (
    <div>
      {!embedded && (
        <>
          <h3 className="text-fg text-base font-medium pb-1">
            당일 매수 최대벽 <span aria-hidden="true" className="text-fg-dim text-sm">ⓘ</span>
          </h3>
          <p className="text-fg-dim text-xs mb-3">
            차트에 보이는 거래일마다, 그 날 매수 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 그날 구간만큼
            수평선을 그립니다. 그 벽이 서 있던 1분 안에 체결이 그 가격을 친 것만 「체결된 벽」으로 봅니다.
            분봉 차트에서만 표시됩니다
          </p>
        </>
      )}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">체결된 벽</span>
          <MAStylePicker color={color} lineWidth={lineWidth} onChange={setStyle} label="체결된 벽" />
        </div>
      </div>
      <div className="border-b border-border my-3" />
      <ToggleRow
        label="전체 최대벽 (터치 무관)"
        description="체결 터치 여부와 무관하게 그 날 가장 크게 걸렸던 벽의 가격에도 수평선을 그립니다. 체결된 벽을 포함하므로 두 선이 같은 가격에 겹칠 수 있습니다."
        checked={allWallEnabled}
        onToggle={() => setAllWallEnabled(!allWallEnabled)}
        testId="settings-toggle-bidPeakAllWallLineEnabled"
      />
      {allWallEnabled && (
        <div className="flex items-center gap-2 mt-2">
          <span className="text-sm text-fg">전체 최대벽</span>
          <MAStylePicker
            color={allWallColor}
            lineWidth={allWallLineWidth}
            onChange={setAllWallStyle}
            label="전체 최대벽"
          />
        </div>
      )}
      <div className="border-b border-border my-3" />
      <ToggleRow
        label="미도달 벽"
        description="당일 저가보다 아래에 걸렸던 벽 중 최대 — 아직 시장가가 닿지 않은 매수벽입니다. 저가가 갱신되면 그 위 벽은 목록에서 빠집니다."
        checked={unreachedEnabled}
        onToggle={() => setUnreachedEnabled(!unreachedEnabled)}
        testId="settings-toggle-bidPeakUnreachedLineEnabled"
      />
      {unreachedEnabled && (
        <div className="flex items-center gap-2 mt-2">
          <span className="text-sm text-fg">미도달 벽</span>
          <MAStylePicker
            color={unreachedColor}
            lineWidth={unreachedLineWidth}
            onChange={setUnreachedStyle}
            label="미도달 벽"
          />
        </div>
      )}
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows
        toggleKeys={['bidPeakIntraMax', 'bidPeakLabelEnabled', 'bidPeakRankArrowEnabled', 'bidPeakVisibleTimeCutoff', 'bidPeakBelowMaEnabled', 'bidPeakBelowDailyMaEnabled']}
      />
      <div className="border-b border-border my-2" />
      <div>
        <div className="text-sm text-fg mb-2">체결된 벽 표시 개수</div>
        <div className="inline-flex rounded-md border border-border overflow-hidden" role="group" aria-label="체결된 벽 표시 개수">
          {RANK_OPTIONS.map((option) => {
            const selected = postTouchRankLimit === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setNumericPref('bidPeakAllPriceRankLimit', option.value)}
                className={[
                  'px-3 py-1.5 text-xs border-r border-border last:border-r-0 transition-colors',
                  selected ? 'bg-accent text-accent-fg' : 'bg-bg-elevated text-fg-dim hover:text-fg',
                ].join(' ')}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

import { useScopedChartPrefs, useChartPrefActions } from '../../state/chartPrefs';
import MAStylePicker from './MAStylePicker';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

const RANK_OPTIONS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
] as const;

const VISIBLE_MAX_RANK_OPTIONS = [
  { value: 0, label: '0' },
  ...RANK_OPTIONS,
] as const;

/** `embedded` — 병합된 「당일 최대벽」 페이지의 서브탭 안에서 렌더될 때 제목·설명을
 *  숨긴다(상위가 이미 표시). 단독 카테고리로 쓰이던 시절과의 호환을 위해 기본 false. */
export default function BidPeakConfig({ embedded = false }: { embedded?: boolean } = {}) {
  const color = useWindowIndicator((s) => s.bidPeakColor);
  const lineWidth = useWindowIndicator((s) => s.bidPeakLineWidth);
  const allPriceColor = useWindowIndicator((s) => s.bidPeakAllPriceColor);
  const allPriceLineWidth = useWindowIndicator((s) => s.bidPeakAllPriceLineWidth);
  const setStyle = useIndicatorActions().setBidPeakStyle;
  const setAllPriceStyle = useIndicatorActions().setBidPeakAllPriceStyle;
  const prefs = useScopedChartPrefs();
  const postTouchRankLimit = prefs.bidPeakAllPriceRankLimit;
  const untradedRankLimit = prefs.bidPeakUntradedRankLimit;
  const visibleMaxRankLimit = prefs.bidPeakVisibleMaxRankLimit;
  const { setNumericPref } = useChartPrefActions();
  return (
    <div>
      {!embedded && (
        <>
          <h3 className="text-fg text-base font-medium pb-1">
            당일 매수 최대벽 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
          </h3>
          <p className="text-fg-dim text-xs mb-3">
            차트에 보이는 거래일마다, 그 날 매수 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 그날 구간만큼
            수평선을 그립니다. 체결된 벽과 미체결된 벽을 각각 표시합니다.
            분봉 차트에서만 표시됩니다.
          </p>
        </>
      )}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">체결된 벽</span>
          <MAStylePicker color={color} lineWidth={lineWidth} onChange={setStyle} label="체결된 벽" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">미체결된 벽</span>
          <MAStylePicker
            color={allPriceColor}
            lineWidth={allPriceLineWidth}
            onChange={setAllPriceStyle}
            label="미체결된 벽"
          />
        </div>
      </div>
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows
        toggleKeys={['bidPeakIntraMax', 'bidPeakShowAllPrices', 'bidPeakLabelEnabled', 'bidPeakVisibleTimeCutoff']}
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
      <div className="mt-3">
        <div className="text-sm text-fg mb-2">미체결된 벽 표시 개수</div>
        <div className="inline-flex rounded-md border border-border overflow-hidden" role="group" aria-label="미체결된 벽 표시 개수">
          {RANK_OPTIONS.map((option) => {
            const selected = untradedRankLimit === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setNumericPref('bidPeakUntradedRankLimit', option.value)}
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
      <div className="mt-3">
        <div className="text-sm text-fg mb-2">보이는 영역 최대벽 표시 개수</div>
        <div className="inline-flex rounded-md border border-border overflow-hidden" role="group" aria-label="보이는 영역 최대벽 표시 개수">
          {VISIBLE_MAX_RANK_OPTIONS.map((option) => {
            const selected = visibleMaxRankLimit === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setNumericPref('bidPeakVisibleMaxRankLimit', option.value)}
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

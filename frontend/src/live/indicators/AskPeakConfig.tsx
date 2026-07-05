import { useLivePageStore } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import MAStylePicker from './MAStylePicker';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

const RANK_OPTIONS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
] as const;

/** 당일 매도 최대벽 상세 설정 — 선 색·두께(MAStylePicker 재활용). */
export default function AskPeakConfig() {
  const color = useLivePageStore((s) => s.askPeakColor);
  const lineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  const allPriceColor = useLivePageStore((s) => s.askPeakAllPriceColor);
  const allPriceLineWidth = useLivePageStore((s) => s.askPeakAllPriceLineWidth);
  const visibleMaxColor = useLivePageStore((s) => s.askPeakVisibleMaxColor);
  const visibleMaxLineWidth = useLivePageStore((s) => s.askPeakVisibleMaxLineWidth);
  const setStyle = useLivePageStore((s) => s.setAskPeakStyle);
  const setAllPriceStyle = useLivePageStore((s) => s.setAskPeakAllPriceStyle);
  const setVisibleMaxStyle = useLivePageStore((s) => s.setAskPeakVisibleMaxStyle);
  const postTouchRankLimit = useChartPrefsStore((s) => s.askPeakAllPriceRankLimit);
  const untradedRankLimit = useChartPrefsStore((s) => s.askPeakUntradedRankLimit);
  const visibleMaxRankLimit = useChartPrefsStore((s) => s.askPeakVisibleMaxRankLimit);
  const setNumericPref = useChartPrefsStore((s) => s.setNumericPref);
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        당일 매도 최대벽 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        차트에 보이는 거래일마다, 그 날 매도 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 그날 구간만큼
        수평선을 그립니다. 미체결 포함 최대벽은 체결가격 기준 최대벽보다 물량이 클 때만 함께 표시됩니다.
        분봉 차트에서만 표시됩니다.
      </p>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">체결가격 기준 최대벽</span>
          <MAStylePicker color={color} lineWidth={lineWidth} onChange={setStyle} label="체결가격 기준 최대벽" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">미체결 포함 최대벽</span>
          <MAStylePicker
            color={allPriceColor}
            lineWidth={allPriceLineWidth}
            onChange={setAllPriceStyle}
            label="미체결 포함 최대벽"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">보이는 영역 최대벽</span>
          <MAStylePicker
            color={visibleMaxColor}
            lineWidth={visibleMaxLineWidth}
            onChange={setVisibleMaxStyle}
            label="보이는 영역 최대벽"
          />
        </div>
      </div>
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows
        toggleKeys={['askPeakIntraMax', 'askPeakShowAllPrices', 'askPeakLabelEnabled', 'askPeakVisibleTimeCutoff']}
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
                onClick={() => setNumericPref('askPeakAllPriceRankLimit', option.value)}
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
                onClick={() => setNumericPref('askPeakUntradedRankLimit', option.value)}
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
          {RANK_OPTIONS.map((option) => {
            const selected = visibleMaxRankLimit === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setNumericPref('askPeakVisibleMaxRankLimit', option.value)}
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

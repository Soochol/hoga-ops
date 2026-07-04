import { useLivePageStore } from '../../state/livePage';
import MAStylePicker from './MAStylePicker';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

export default function BidPeakConfig() {
  const color = useLivePageStore((s) => s.bidPeakColor);
  const lineWidth = useLivePageStore((s) => s.bidPeakLineWidth);
  const allPriceColor = useLivePageStore((s) => s.bidPeakAllPriceColor);
  const allPriceLineWidth = useLivePageStore((s) => s.bidPeakAllPriceLineWidth);
  const setStyle = useLivePageStore((s) => s.setBidPeakStyle);
  const setAllPriceStyle = useLivePageStore((s) => s.setBidPeakAllPriceStyle);
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        당일 매수 최대벽 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        차트에 보이는 거래일마다, 그 날 매수 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 그날 구간만큼
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
      </div>
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['bidPeakIntraMax', 'bidPeakShowAllPrices', 'bidPeakVisibleTimeCutoff']} />
    </div>
  );
}

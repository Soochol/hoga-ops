import { useLivePageStore } from '../../state/livePage';
import MAStylePicker from './MAStylePicker';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

/** 당일 매도 최대벽 상세 설정 — 선 색·두께(MAStylePicker 재활용). */
export default function AskPeakConfig() {
  const color = useLivePageStore((s) => s.askPeakColor);
  const lineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  const allPriceColor = useLivePageStore((s) => s.askPeakAllPriceColor);
  const allPriceLineWidth = useLivePageStore((s) => s.askPeakAllPriceLineWidth);
  const setStyle = useLivePageStore((s) => s.setAskPeakStyle);
  const setAllPriceStyle = useLivePageStore((s) => s.setAskPeakAllPriceStyle);
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        당일 매도 최대벽 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        차트에 보이는 거래일마다, 그 날 매도 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 그날 구간만큼
        수평선을 그립니다. 오늘은 체결가격 기준과 미체결 포함 최대벽을 함께 볼 수 있고, 과거 거래일은 기존 기준
        단일선으로 표시됩니다. 분봉 차트에서만 표시됩니다.
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
      <IndicatorPrefRows toggleKeys={['askPeakIntraMax', 'askPeakShowAllPrices']} />
    </div>
  );
}

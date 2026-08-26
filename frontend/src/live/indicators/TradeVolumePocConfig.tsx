import ColorSwatchPicker from './ColorSwatchPicker';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';
import { withAlpha } from '../../chart/util/colorAlpha';

/** hex 파싱 실패 시의 POC 기본색 폴백 — 종전 하드코딩과 같은 보라. */
const POC_FALLBACK_RGB = '168, 85, 247';



export default function TradeVolumePocConfig() {
  const color = useWindowIndicator((s) => s.tradeVolumePocColor);
  const opacity = useWindowIndicator((s) => s.tradeVolumePocOpacity);
  const rangeCount = useWindowIndicator((s) => s.volumeDistributionRangeCount);
  const setStyle = useIndicatorActions().setTradeVolumePocStyle;
  const opacityPct = Math.round(opacity * 100);

  return (
    <div>
      <div className="mb-3">
        <div className="text-xs text-fg-dim mb-1.5">색상</div>
        <div className="flex items-center gap-2">
          <div
            aria-hidden="true"
            className="h-6 w-10 rounded border border-border-subtle"
            style={{ backgroundColor: withAlpha(color, opacity, `rgba(${POC_FALLBACK_RGB}, ${opacity})`), borderColor: color }}
          />
          <ColorSwatchPicker
            label="당일 최대 매물대 색상"
            color={color}
            onChange={(next) => setStyle({ color: next })}
          />
        </div>
      </div>
      <div className="mb-3">
        <div className="flex items-center justify-between text-xs text-fg-dim mb-1.5">
          <span>투명도</span>
          <span>{opacityPct}%</span>
        </div>
        <input
          type="range"
          min={5}
          max={40}
          step={1}
          value={opacityPct}
          aria-label="당일 최대 매물대 투명도"
          className="w-full"
          onChange={(event) => setStyle({ opacity: Number(event.currentTarget.value) / 100 })}
        />
      </div>
      <div className="text-xs text-fg-dim leading-5">
        <div>범위: 연속체결 매물대 분포와 동일한 {rangeCount}개 가격 구간</div>
        <div>선택: 체결량이 가장 큰 max bar 구간</div>
        <div>표시: 가격대 범위 밴드</div>
      </div>
    </div>
  );
}

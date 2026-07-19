import MAStylePicker from './MAStylePicker';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

/** 호가 잔량 히트맵 상세 설정 — 매수/매도 색(MAStylePicker) + 최대 불투명도. */
export default function DepthHeatmapConfig() {
  const bidColor = useWindowIndicator((s) => s.depthHeatmapBidColor);
  const askColor = useWindowIndicator((s) => s.depthHeatmapAskColor);
  const maxOpacity = useWindowIndicator((s) => s.depthHeatmapMaxOpacity);
  const setStyle = useIndicatorActions().setDepthHeatmapStyle;
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        호가 잔량 히트맵 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        각 분봉 시점의 10호가 매수·매도 잔량을 캔들 뒤 색상 강도로 표시합니다. 강도는 화면에
        보이는 범위의 최대 잔량 기준으로 정규화됩니다. 분봉 차트에서만 표시됩니다.
      </p>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">매수 색상</span>
          <MAStylePicker
            color={bidColor}
            lineWidth={2}
            onChange={(p) => { if (p.color) setStyle({ bidColor: p.color }); }}
            label="매수 색상"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">매도 색상</span>
          <MAStylePicker
            color={askColor}
            lineWidth={2}
            onChange={(p) => { if (p.color) setStyle({ askColor: p.color }); }}
            label="매도 색상"
          />
        </div>
      </div>
      <div className="border-b border-border my-3" />
      <div>
        <label htmlFor="dh-opacity" className="text-sm text-fg mb-2 block">
          최대 불투명도 <span className="text-fg-dim text-xs">{Math.round(maxOpacity * 100)}%</span>
        </label>
        <input
          id="dh-opacity"
          type="range"
          min={0.2}
          max={1}
          step={0.05}
          value={maxOpacity}
          onChange={(e) => setStyle({ maxOpacity: Number(e.target.value) })}
          className="w-full"
        />
      </div>
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['depthHeatmapIntraMax']} />
    </div>
  );
}

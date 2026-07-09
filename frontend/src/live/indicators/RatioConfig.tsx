import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import ToggleRow from '../settings/ToggleRow';
import MAStylePicker from './MAStylePicker';
import { useLivePageStore } from '../../state/livePage';

/** 호가비 상세 — 매수/매도 우위 범례 + 현재값 수평선 + 극단값 필터 설정.
 *  값이 양수면 매도 우위(파랑), 음수면 매수 우위(빨강)이나 범례는 색→의미로 표기. */
export default function RatioConfig() {
  const levelEnabled = useLivePageStore((s) => s.ratioLevelLineEnabled);
  const setLevelEnabled = useLivePageStore((s) => s.setRatioLevelLineEnabled);
  const color = useLivePageStore((s) => s.ratioLevelColor);
  const width = useLivePageStore((s) => s.ratioLevelWidth);
  const style = useLivePageStore((s) => s.ratioLevelStyle);
  const setStyle = useLivePageStore((s) => s.setRatioLevelStyle);
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        호가비 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        매수·매도 호가 총잔량의 불균형(우위)을 0 기준선 위아래로 표시합니다.
      </p>
      <SignColorLegend up="매수 우위" down="매도 우위" />
      <div className="border-b border-border my-3" />
      <ToggleRow
        label="현재값 수평선"
        description="현재 호가비 값에 수평 기준선을 그립니다."
        checked={levelEnabled}
        onToggle={() => setLevelEnabled(!levelEnabled)}
        testId="settings-toggle-ratioLevelLineEnabled"
      />
      {levelEnabled && (
        <div className="flex items-center gap-2 mt-2">
          <span className="text-sm text-fg">수평선</span>
          <MAStylePicker
            color={color}
            lineWidth={width}
            lineStyle={style}
            onChange={setStyle}
            onLineStyleChange={(lineStyle) => setStyle({ lineStyle })}
            label="호가비 수평선"
          />
        </div>
      )}
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['ratioOutlierFilterEnabled', 'ratioIntraMax']} />
    </div>
  );
}

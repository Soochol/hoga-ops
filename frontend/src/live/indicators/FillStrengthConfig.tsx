import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

/** 체결강도 상세 — 매수/매도 체결량 범례 + 당일 누적선 설정. */
export default function FillStrengthConfig() {
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        체결강도 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        해당 분봉 동안 체결된 매수·매도 물량을 막대로 표시합니다.
      </p>
      <SignColorLegend up="매수 체결" down="매도 체결" />
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['fillStrengthCumulative']} />
    </div>
  );
}

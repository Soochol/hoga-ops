import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

/** 체결강도 상세 — 매수/매도 체결량 범례 + 당일 누적선 설정. */
export default function FillStrengthConfig() {
  return (
    <div>
      <SignColorLegend up="매수 체결" down="매도 체결" />
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['fillStrengthCumulative']} />
    </div>
  );
}

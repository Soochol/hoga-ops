import { IndicatorSettingsGroup } from './IndicatorSettingsLayout';
import SignColorLegend from './SignColorLegend';

export default function TradeValueConfig() {
  return (
    <IndicatorSettingsGroup label="표시 기준">
      <SignColorLegend up="상승봉" down="하락봉" />
      <p className="mt-3 text-xs text-fg-dim">일봉·주봉·월봉의 거래대금을 억·조 단위로 표시합니다.</p>
    </IndicatorSettingsGroup>
  );
}

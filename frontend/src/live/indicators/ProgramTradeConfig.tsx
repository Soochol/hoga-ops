import { IndicatorSettingsGroup } from './IndicatorSettingsLayout';
export default function ProgramTradeConfig() {
  return (
    <IndicatorSettingsGroup label="표시 기준">
      <p className="text-fg-dim text-xs mt-2">
        0 위는 순매수, 0 아래는 순매도입니다
      </p>
    </IndicatorSettingsGroup>
  );
}

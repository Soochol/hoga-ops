import { useIndicatorActions, useWindowIndicators } from '../workspace/windowView';
import { IndicatorSettingsGroup, IndicatorLineWidthRow } from './IndicatorSettingsLayout';
import LineVisibilityRow from './LineVisibilityRow';
import ColorSwatchPicker from './ColorSwatchPicker';

export default function InvestorHoldingsConfig() {
  const settings = useWindowIndicators();
  const { setInvestorHoldingsSettings } = useIndicatorActions();
  return <div className="indicator-settings-groups">
    <IndicatorSettingsGroup label="표시·스타일">
      <label className="flex items-center justify-between gap-3 text-xs text-fg">보유 기준
        <select aria-label="보유 기준" value={settings.investorHoldingsMetric} onChange={event => {
          const metric = event.target.value;
          if (metric === 'quantity' || metric === 'ratio') setInvestorHoldingsSettings({ investorHoldingsMetric: metric });
        }} className="rounded border border-border bg-bg-card px-2 py-1">
          <option value="quantity">보유수량(주)</option><option value="ratio">보유비중(%)</option>
        </select>
      </label>
      <LineVisibilityRow label="외국인" lineKey="investorHoldingsForeign" toggleLabel="보유 외국인 표시">
        <ColorSwatchPicker label="보유 외국인" color={settings.investorHoldingsForeignColor}
          onChange={investorHoldingsForeignColor => setInvestorHoldingsSettings({ investorHoldingsForeignColor })} />
      </LineVisibilityRow>
      <IndicatorLineWidthRow label="보유" value={settings.investorHoldingsWidth}
        onChange={investorHoldingsWidth => setInvestorHoldingsSettings({ investorHoldingsWidth })} />
    </IndicatorSettingsGroup>
    <IndicatorSettingsGroup label="기준">
      <p className="text-xs text-fg-dim">키움 · KRX · 국내 개별주식 일봉 지원. 외국인 실제 보유잔액이며 순매수 누적이 아닙니다.</p>
      <p className="text-xs text-fg-dim">비중은 공급자가 제공한 값입니다. 기업행사 등을 자체 보정하지 않으며 자료가 없는 날짜는 연결하지 않습니다. 당일 확정 시각은 미확인입니다.</p>
    </IndicatorSettingsGroup>
  </div>;
}

import SignColorLegend from './SignColorLegend';
import { useIndicatorActions, useWindowIndicator } from '../workspace/windowView';

export default function InvestorNetConfig({ grossSupported = true }: { grossSupported?: boolean }) {
  const storedSide = useWindowIndicator((s) => s.investorTradeSide);
  const side = grossSupported ? storedSide : 'net';
  const setSide = useIndicatorActions().setInvestorTradeSide;
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between gap-3 text-xs text-fg">
        매매 기준
        <select aria-label="투자자 매매 기준" value={side} disabled={!grossSupported}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'net' || value === 'buy' || value === 'sell') setSide(value);
          }} className="rounded border border-border bg-bg-card px-2 py-1">
          <option value="net">순매수</option>
          <option value="buy">총매수</option>
          <option value="sell">총매도</option>
        </select>
      </label>
      <p className="text-xs text-fg-dim">이 차트의 외국인·기관 지표에 함께 적용됩니다.</p>
      {side === 'net' ? <SignColorLegend up="순매수" down="순매도" />
        : <p className="text-xs text-fg-dim">{side === 'buy' ? '총매수량 · 매수 색상' : '총매도량 · 매도 색상'} · 수량(주)</p>}
      {!grossSupported && <p className="text-xs text-fg-dim">지수 차트는 순매수만 지원합니다.</p>}
      <p className="text-fg-dim text-xs">일봉(D)에서만 표시됩니다</p>
    </div>
  );
}

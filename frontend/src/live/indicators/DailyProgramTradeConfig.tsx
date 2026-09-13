import { useIndicatorActions, useWindowIndicator } from '../workspace/windowView';
import SignColorLegend from './SignColorLegend';

export default function DailyProgramTradeConfig() {
  const side = useWindowIndicator((s) => s.dailyProgramTradeSide);
  const { setDailyProgramTradeSide } = useIndicatorActions();
  return <div className="space-y-3">
    <label className="flex items-center justify-between gap-3 text-xs text-fg">
      매매 기준
      <select aria-label="프로그램 매매 기준" value={side}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'net' || value === 'buy' || value === 'sell') setDailyProgramTradeSide(value);
        }} className="rounded border border-border bg-bg-card px-2 py-1">
        <option value="net">순매수</option><option value="buy">총매수</option><option value="sell">총매도</option>
      </select>
    </label>
    {side === 'net' ? <SignColorLegend up="순매수" down="순매도" />
      : <p className="text-xs text-fg-dim">{side === 'buy' ? '총매수량 · 매수 색상' : '총매도량 · 매도 색상'}</p>}
    <p className="text-xs text-fg-dim">종목 일봉 전용 · KRX 수량(주) · 당일 값은 잠정치입니다.</p>
  </div>;
}

import type { Candle } from '../api/types';

/** Daily turnover comes directly from the hovered candle, without extra queries. */
export default function DailyCandleDetails({ candle }: { candle: Candle }) {
  const turnover = candle.trade_value_won;
  return (
    <div data-testid="daily-candle-details">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <span style={{ color: 'var(--fg-dimmer)' }}>거래대금</span>
        <span>{turnover != null && Number.isFinite(turnover) && turnover >= 0
          ? `${(turnover / 100_000_000).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}억`
          : '—'}</span>
      </div>
    </div>
  );
}

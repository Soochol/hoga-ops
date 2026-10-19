import { CHANGE_REFERENCE_LABELS } from './CandleSettings';
import type { ScreenerOccurrence } from '../api/screener';

const PRICE = { open: '시가', high: '고가', low: '저가', close: '종가' };
const won = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

export function BarMatchEvidence({ event }: { event: ScreenerOccurrence }) {
  const amount = event.bar_trade_value_match;
  if (amount) return <span className="font-data text-xs text-fg-dim">
    {won(amount.trade_value_won / 1e8)}억 추정 · {amount.method === 'daily_estimate_sum' ? '일별 추정치 합계' : 'OHLCV 추정'}
    {' · '}{amount.is_open ? '진행 중' : '완료'}
  </span>;
  const change = event.bar_change_match;
  if (change) return <span className="font-data text-xs text-fg-dim">
    {CHANGE_REFERENCE_LABELS[change.change_reference]} {won(change.change_pct)}% · 종가 {won(change.close)}원
    {' · '}기준 {won(change.reference_close)}원 · {change.is_open ? '진행 중' : '완료'}
  </span>;
  const price = event.bar_price_match;
  const match = price ?? event.bar_match;
  if (!match) return null;
  return <span className="font-data text-xs text-fg-dim">{price
    ? `${PRICE[price.source]} ${won(price.value)}원 · 비교값 ${won(price.reference)}원`
    : `${event.bar_match!.volume.toLocaleString('ko-KR')}주`}
    {' · '}{match.is_open ? '진행 중' : '완료'}
  </span>;
}

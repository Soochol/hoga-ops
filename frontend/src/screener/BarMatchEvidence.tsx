import type { ScreenerOccurrence } from '../api/screener';

const PRICE = { open: '시가', high: '고가', low: '저가', close: '종가' };
const won = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

export function BarMatchEvidence({ event }: { event: ScreenerOccurrence }) {
  const price = event.bar_price_match;
  const match = price ?? event.bar_match;
  if (!match) return null;
  return <span className="font-data text-xs text-fg-dim">{price
    ? `${PRICE[price.source]} ${won(price.value)}원 · 비교값 ${won(price.reference)}원`
    : `${event.bar_match!.volume.toLocaleString('ko-KR')}주`}
    {' · '}{match.is_open ? '진행 중' : '완료'}
  </span>;
}

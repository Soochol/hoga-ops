import { CHANGE_REFERENCE_LABELS } from './candleLabels';
import type { ScreenerOccurrence } from '../api/screener';

const PRICE = { open: '시가', high: '고가', low: '저가', close: '종가' };
const won = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

export function BarMatchEvidence({ event }: { event: ScreenerOccurrence }) {
  const changeRank = event.change_pct_rank_match;
  if (changeRank) return <span className="font-data text-xs text-fg-dim">
    {{ all: '전체', kospi: '코스피', kosdaq: '코스닥' }[changeRank.market]}
    {' · '}{changeRank.venue === 'UN' ? '통합' : changeRank.venue} · 등락률 {changeRank.rank}위
    {' · '}전일 종가 대비 {changeRank.change_pct > 0 ? '+' : ''}{won(changeRank.change_pct)}%
    {' · '}{new Date(changeRank.fetched_at_ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 조회
  </span>;
  const rank = event.trade_value_rank_match;
  if (rank) return <span className="font-data text-xs text-fg-dim">
    {{ all: '전체', kospi: '코스피', kosdaq: '코스닥' }[rank.market]}
    {' · '}{rank.venue === 'UN' ? '통합' : rank.venue} · 거래대금 {rank.rank}위
    {rank.trade_value_won != null ? ` · ${won(rank.trade_value_won / 1e8)}억` : ''}
    {' · '}{new Date(rank.fetched_at_ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 조회
  </span>;
  const quantity = event.volume_evidence;
  if (quantity) return <span className="font-data text-xs text-fg-dim">
    {quantity.basis === 'share_adjusted' ? '주식 수 단위 보정' : '실제 거래량'} {quantity.compared_volume}주
    {' · '}비교 최대 {quantity.maximum}주 · 원본 {quantity.original_volume}주
  </span>;
  const actualAmount = event.amount_evidence;
  if (actualAmount) return <span className="font-data text-xs text-fg-dim">
    {won(actualAmount.trade_value_won / 1e8)}억 · {{ provider_actual: '공급자 실제 거래대금',
      ohlcv_estimate: '원주가 OHLCV 추정', mixed_daily: '실제·추정 일별 합계' }[actualAmount.method]}
  </span>;
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
    : `${event.bar_match!.volume_is_lower_bound ? '최소 ' : ''}${event.bar_match!.volume.toLocaleString('ko-KR')}주`}
    {' · '}{match.is_open ? '진행 중' : '완료'}
  </span>;
}

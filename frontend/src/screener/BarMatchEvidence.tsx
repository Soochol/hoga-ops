import { maOperandLabel } from './maLabels';
import { operandLabel, PRICE_COMPARE_SYMBOLS } from './priceCompareLabels';
import { CHANGE_REFERENCE_LABELS } from './candleLabels';
import type { ScreenerOccurrence } from '../api/screener';
import { VolumeConditionEvidence } from './VolumeConditionEvidence';

const PRICE = { open: '시가', high: '고가', low: '저가', close: '종가' };
const won = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

export function BarMatchEvidence({ event }: { event: ScreenerOccurrence }) {
  if (event.bar_volume_condition_match) return <VolumeConditionEvidence match={event.bar_volume_condition_match} />;
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
  const ma = event.bar_ma_match;
  if (ma) {
    const price = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 20 });
    const stamp = (value: number) => new Date(value + 9 * 60 * 60 * 1000).toISOString()
      .slice(0, ma.timeframe.endsWith('m') ? 16 : 10).replace('T', ' ');
    const relation = ma.relation ? PRICE_COMPARE_SYMBOLS[ma.relation] : ma.direction === 'up' ? '>' : ma.direction === 'down' ? '<' : '/';
    return <span className="block font-data text-xs text-fg-dim">
      {maOperandLabel(ma.left)} {price(ma.left.value)}원 {relation} {maOperandLabel(ma.right)} {price(ma.right.value)}원
      {ma.value_pct != null && <span className="block">{ma.kind === 'slope' ? '기울기' : '이격률'} {price(ma.value_pct)}%</span>}
      {ma.previous_left && ma.previous_right && <span className="block">
        직전 A {price(ma.previous_left.value)}원 · B {price(ma.previous_right.value)}원 → {ma.direction === 'up' ? '상향' : '하향'} 돌파·교차
      </span>}
      <span className="block">A {stamp(ma.left.bar_start_ms)} · 계산 시작 {stamp(ma.left.window_start_ms)}
        {' · '}B {stamp(ma.right.bar_start_ms)} · 계산 시작 {stamp(ma.right.window_start_ms)}
        {' · '}{ma.is_open ? '진행 중' : '완료'}</span>
    </span>;
  }
  const compare = event.bar_price_compare_match;
  if (compare) {
    const price = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 20 });
    const time = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString()
      .slice(0, compare.timeframe.endsWith('m') ? 16 : 10).replace('T', ' ');
    return <span className="block font-data text-xs text-fg-dim">
      {operandLabel(compare.left)} {price(compare.left.value)}원 {PRICE_COMPARE_SYMBOLS[compare.relation]} {operandLabel(compare.right)} {price(compare.right.value)}원
      <span className="block">A {time(compare.left.bar_start_ms)} · {compare.left.is_open ? '진행 중' : '완료'}
        {' · '}B {time(compare.right.bar_start_ms)} · {compare.right.is_open ? '진행 중' : '완료'}</span>
    </span>;
  }
  const price = event.bar_price_match;
  const match = price ?? event.bar_match;
  if (!match) return null;
  return <span className="font-data text-xs text-fg-dim">{price
    ? `${PRICE[price.source]} ${won(price.value)}원 · 비교값 ${won(price.reference)}원`
    : `${event.bar_match!.volume_is_lower_bound ? '최소 ' : ''}${event.bar_match!.volume.toLocaleString('ko-KR')}주`}
    {' · '}{match.is_open ? '진행 중' : '완료'}
  </span>;
}

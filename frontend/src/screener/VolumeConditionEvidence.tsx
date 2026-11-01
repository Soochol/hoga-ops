import type { BarVolumeConditionMatch } from '../api/screener';
import { PRICE_COMPARE_SYMBOLS } from './priceCompareLabels';
import { volumeValueLabel } from './volumeLabels';

export function VolumeConditionEvidence({ match: m }: { match: BarVolumeConditionMatch }) {
  const stamp = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString()
    .slice(0, m.timeframe.endsWith('m') ? 16 : 10).replace('T', ' ');
  return <span className="block font-data text-xs text-fg-dim">
    {m.left.offset}봉 전 거래량 {volumeValueLabel(m.left.value)}주
    {m.right && m.relation && <> {PRICE_COMPARE_SYMBOLS[m.relation]} {m.right.offset}봉 전 거래량 {volumeValueLabel(m.right.value)}주</>}
    {m.average != null && <span className="block">직전 {m.period}봉 평균 {volumeValueLabel(m.average)}주
      {' · '}평균의 {m.ratio_pct?.toLocaleString('ko-KR', { maximumFractionDigits: 6 })}%</span>}
    <span className="block">대상 {stamp(m.left.bar_start_ms)} · {m.left.is_open ? '진행 중' : '완료'}
      {m.right && <> · 비교 {stamp(m.right.bar_start_ms)} · {m.right.is_open ? '진행 중' : '완료'}</>}
      {m.window_start_ms != null && m.window_end_ms != null && <> · 평균 구간 {stamp(m.window_start_ms)}~{stamp(m.window_end_ms)}</>}
    </span>
    <span className="block">{m.basis === 'raw' ? '실제 거래량' : m.basis === 'share_adjusted' ? '주식 수 단위 보정' : '기존 보정 거래량'}
      {' · '}발생 봉 {m.is_open ? '진행 중' : '완료'}</span>
  </span>;
}

import type { ConditionLeaf } from '../api/screener';
import { CHANGE_REFERENCE_LABELS, timeframeLabel } from './candleLabels';
import { hhmmToTimeValue } from './paramFormsHelpers';

const number = (value: number | undefined) => value == null ? '미지정' : value.toLocaleString('ko-KR');

/** Display-only sentences. Catalog summaries used by saved results stay unchanged. */
export function conditionDescription(leaf: ConditionLeaf): string {
  switch (leaf.type) {
    case 'price_range': {
      const { min, max } = leaf.params;
      return min != null && max != null ? `${number(min)} ~ ${number(max)}원`
        : min != null ? `${number(min)}원 이상` : max != null ? `${number(max)}원 이하` : '가격 제한 없음';
    }
    case 'trade_value': {
      const p = leaf.params;
      return `${timeframeLabel(p.timeframe)} · 최신 봉 거래대금 ${number(p.min_eok)}억 원 이상`;
    }
    case 'trade_value_period': {
      const p = leaf.params;
      const range = 'mode' in p ? `${p.start_date} ~ ${p.end_date}` : `최근 ${number(p.lookback)}봉`;
      return `${timeframeLabel('timeframe' in p ? p.timeframe : undefined)} · ${range} 중 한 봉이라도 ${number(p.min_eok)}억 원 이상`;
    }
    case 'new_high_today':
    case 'new_high_vol_today': {
      const p = leaf.params;
      return `${timeframeLabel(p.timeframe)} · 최신 봉이 ${number(p.period)}봉 ${leaf.type === 'new_high_today' ? '신고가' : '신고거래량'} 달성`;
    }
    case 'new_high': {
      const p = leaf.params;
      return `${timeframeLabel(p.timeframe)} · 최근 ${number(p.lookback)}봉 내 ${number(p.period)}봉 신고가 달성`;
    }
    case 'new_high_vol': {
      const p = leaf.params;
      if (!('mode' in p)) return `${timeframeLabel(p.timeframe)} · 최근 ${number(p.lookback)}봉 내 ${number(p.period)}봉 신고거래량 달성`;
      const unit = { years: '년', trading_days: '거래일', bars: '봉' }[p.record_period.unit];
      return `${timeframeLabel('timeframe' in p ? p.timeframe : undefined)} · ${p.start_date} ~ ${p.end_date} 내 ${number(p.record_period.value)}${unit} 최대거래량 달성`;
    }
    case 'high_off_peak': {
      const p = leaf.params;
      return `${timeframeLabel(p.timeframe)} · 최근 ${number(p.period)}봉 최고 고가 대비 최신 고가 −${number(p.pct)}% ${p.side === 'within' ? '이내' : '이외'}`;
    }
    case 'change_pct': {
      const p = leaf.params;
      const threshold = p.op === 'between' ? `${number(p.lo)} ~ ${number(p.hi)}%`
        : `${number(p.pct)}% ${p.op === 'gte' ? '이상' : '이하'}`;
      return `${timeframeLabel(p.timeframe)} · ${CHANGE_REFERENCE_LABELS[p.change_reference ?? 'previous_day']} ${threshold}`;
    }
    case 'ma': {
      const p = leaf.params;
      const source = { open: '시가', high: '고가', low: '저가', close: '종가' }[p.source ?? 'close'];
      return `${timeframeLabel(p.timeframe)} · ${source}가 같은 기준의 ${number(p.period)}봉 SMA ${p.relation === 'above' ? '이상' : '이하'}`;
    }
    case 'ask_depth_new_high':
    case 'bid_depth_new_high': {
      const p = leaf.params;
      return `당일 peak가 직전 ${number(p.lookback)}거래일 peak의 ${number(p.threshold_pct)}% 이상`;
    }
    case 'ask_depth_new_high_period':
    case 'bid_depth_new_high_period': {
      const p = leaf.params;
      return `최근 ${number(p.lookback)}거래일 내 각 발생일 직전 ${number(p.period)}거래일 peak의 ${number(p.threshold_pct)}% 이상`;
    }
    case 'ask_depth_renewal':
    case 'bid_depth_renewal': {
      const p = leaf.params;
      return `${hhmmToTimeValue(p.start_hhmm)} 이후 총잔량이 그 시각 이전 최대의 ${number(p.threshold_pct)}% 이상`;
    }
  }
}

export function conditionScope(leaf: ConditionLeaf): string {
  if (leaf.type === 'ask_depth_renewal' || leaf.type === 'bid_depth_renewal') return '장중 전용';
  if (leaf.type.includes('_depth_')) return '잔량 데이터';
  return leaf.type === 'price_range' ? '가격 범위' : '봉 기준';
}

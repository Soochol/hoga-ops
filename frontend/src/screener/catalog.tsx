import { nanoid } from 'nanoid';
import type { ConditionLeaf, ConditionType } from '../api/screener';
import { TradeValueForm, BreakoutForm, ChangePctForm, PriceRangeForm, MaForm } from './paramForms';

interface CatalogEntry {
  label: string;
  defaultParams: ConditionLeaf['params'];
  ParamForm: React.FC<{ params: any; onChange: (p: any) => void }>;
  summarize: (p: any) => string;
}

export const CONDITION_ORDER: ConditionType[] =
  ['trade_value', 'new_high', 'new_high_vol', 'change_pct', 'price_range', 'ma'];

const OP = { gte: '≥', lte: '≤', between: '사이' } as const;

export const CONDITION_CATALOG: Record<ConditionType, CatalogEntry> = {
  trade_value: { label: '거래대금', defaultParams: { min_eok: 50 }, ParamForm: TradeValueForm,
    summarize: (p) => `≥ ${p.min_eok}억` },
  new_high: { label: '신고가', defaultParams: { lookback: 200, period: 500 }, ParamForm: BreakoutForm,
    summarize: (p) => `${p.lookback}·${p.period}` },
  new_high_vol: { label: '신고거래량', defaultParams: { lookback: 60, period: 250 }, ParamForm: BreakoutForm,
    summarize: (p) => `${p.lookback}·${p.period}` },
  change_pct: { label: '등락률', defaultParams: { op: 'gte', pct: 5 }, ParamForm: ChangePctForm,
    summarize: (p) => {
      if (p.op === 'between') return (p.lo != null && p.hi != null) ? `${p.lo}~${p.hi}%` : '사이';
      return `${OP[p.op as 'gte' | 'lte']} ${p.pct ?? ''}%`;
    } },
  price_range: { label: '현재가 범위', defaultParams: { min: 1000 }, ParamForm: PriceRangeForm,
    summarize: (p) => {
      if (p.min != null && p.max != null) return `${p.min}~${p.max}원`;
      if (p.min != null) return `≥ ${p.min}원`;
      if (p.max != null) return `≤ ${p.max}원`;
      return '—';
    } },
  ma: { label: '이동평균', defaultParams: { period: 20, relation: 'above' }, ParamForm: MaForm,
    summarize: (p) => `MA${p.period} ${p.relation === 'above' ? '위' : '아래'}` },
};

export function makeLeaf(type: ConditionType): ConditionLeaf {
  return { id: nanoid(8), type, params: structuredClone(CONDITION_CATALOG[type].defaultParams) } as ConditionLeaf;
}

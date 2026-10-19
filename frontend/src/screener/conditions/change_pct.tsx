import { candleSummary, CHANGE_REFERENCE_LABELS } from '../CandleSettings';
import type { CatalogEntry } from './types';
import { ChangePctForm } from './change_pctForm';


const OP = { gte: '≥', lte: '≤', between: '사이' } as const;


export const change_pct: CatalogEntry<'change_pct'> = {
  label: '등락률', defaultParams: { op: 'gte', pct: 5 }, ParamForm: ChangePctForm,
  summarize: p => candleSummary(p, `${CHANGE_REFERENCE_LABELS[p.change_reference ?? 'previous_day']} ${p.op === 'between'
    ? (p.lo != null && p.hi != null ? `${p.lo}~${p.hi}%` : '사이')
    : `${OP[p.op]} ${p.pct ?? ''}%`}`),
};

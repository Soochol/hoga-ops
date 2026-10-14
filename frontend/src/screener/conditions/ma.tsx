import type { MaParams, MaSource } from '../../api/screener';
import type { CatalogEntry } from './types';
import { MaForm } from './maForm';


const PRICE_SOURCE_LABEL: Record<MaSource, string> = {
  open: '시가',
  high: '고가',
  low: '저가',
  close: '종가',
};


const sourceOf = (params: MaParams): MaSource => params.source ?? 'close';


export const ma: CatalogEntry<'ma'> = {
  label: '이동평균', defaultParams: { period: 20, relation: 'above' }, ParamForm: MaForm,
  summarize: (p) => `${PRICE_SOURCE_LABEL[sourceOf(p)]} ${p.relation === 'above' ? '≥' : '≤'} MA${p.period}`,
};

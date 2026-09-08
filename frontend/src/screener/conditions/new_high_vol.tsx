import type { CatalogEntry } from './types';
import { HistoryVolumeForm } from '../HistoryVolumeForm';

export const new_high_vol: CatalogEntry = {
  label: '기간내 신고거래량', defaultParams: { lookback: 60, period: 250 }, ParamForm: HistoryVolumeForm,
  summarize: (p) => 'mode' in p ? `${p.start_date}~${p.end_date} · ${p.record_period.value}${p.record_period.unit === 'years' ? '년' : '거래일'}` : `${p.lookback}·${p.period}`,
};

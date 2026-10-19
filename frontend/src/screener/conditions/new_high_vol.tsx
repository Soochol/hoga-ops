import type { CatalogEntry } from './types';
import { HistoryVolumeForm, volumeTimeframeLabel } from '../HistoryVolumeForm';

export const new_high_vol: CatalogEntry<'new_high_vol'> = {
  label: '기간내 신고거래량', defaultParams: { lookback: 60, period: 250 }, ParamForm: HistoryVolumeForm,
  summarize: (p) => 'mode' in p
    ? `${p.start_date}~${p.end_date} · ${p.record_period.value}${p.record_period.unit === 'years' ? '년' : p.record_period.unit === 'bars' ? '봉' : '거래일'}${'timeframe' in p ? ` · ${volumeTimeframeLabel(p.timeframe)}봉` : ''}`
    : `${p.timeframe ? `${volumeTimeframeLabel(p.timeframe)}봉 · ` : ''}${p.lookback}·${p.period}${p.include_open_bar === false ? ' · 완료봉' : ''}`,
};

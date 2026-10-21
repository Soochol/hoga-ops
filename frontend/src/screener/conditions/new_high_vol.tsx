import type { CatalogEntry } from './types';
import { HistoryVolumeForm } from '../HistoryVolumeForm';
import { candleSummary, volumeTimeframeLabel } from '../candleLabels';

export const new_high_vol: CatalogEntry<'new_high_vol'> = {
  label: '기간내 신고거래량', defaultParams: { lookback: 60, period: 250 }, ParamForm: HistoryVolumeForm,
  summarize: (p) => 'mode' in p
    ? `${p.start_date}~${p.end_date} · ${p.record_period.value}${p.record_period.unit === 'years' ? '년' : p.record_period.unit === 'bars' ? '봉' : '거래일'}${'timeframe' in p ? ` · ${volumeTimeframeLabel(p.timeframe)}봉` : ''}`
    : candleSummary(p, `최근 ${p.lookback}봉 이내 · ${p.period}봉 신고거래량`),
};

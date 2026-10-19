import { candleSummary } from '../candleLabels';
import type { HighOffPeakSide } from '../../api/screener';
import type { CatalogEntry } from './types';
import { HighOffPeakForm } from './high_off_peakForm';


const SIDE: Record<HighOffPeakSide, string> = { within: '이내', outside: '이외' };


export const high_off_peak: CatalogEntry<'high_off_peak'> = {
  label: '신고가 대비 고가', defaultParams: { period: 250, pct: 30, side: 'within' }, ParamForm: HighOffPeakForm,
  summarize: (p) => candleSummary(p, `${p.period}봉·−${p.pct}%${SIDE[p.side as HighOffPeakSide]}`),
};

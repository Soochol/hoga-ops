import type { CatalogEntry } from './types';
import { DepthRenewalForm, hhmmToTimeValue } from '../paramForms';

export const bid_depth_renewal: CatalogEntry = {
  label: '매수 총잔량 기준시각 돌파',
  defaultParams: { start_hhmm: 1200, threshold_pct: 100 },
  ParamForm: DepthRenewalForm,
  summarize: (p) => `${hhmmToTimeValue(p.start_hhmm)} 이전 최대의 ${p.threshold_pct}%`,
};

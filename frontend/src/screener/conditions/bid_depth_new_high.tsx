import type { CatalogEntry } from './types';
import { DepthPeakForm } from '../paramForms';

export const bid_depth_new_high: CatalogEntry = {
  label: '매수 총잔량 peak',
  defaultParams: { lookback: 20, threshold_pct: 100 },
  ParamForm: DepthPeakForm,
  summarize: (p) => `${p.lookback}일 peak의 ${p.threshold_pct}%`,
};

import type { CatalogEntry } from './types';
import { DepthPeakForm } from '../paramForms';

export const ask_depth_new_high: CatalogEntry = {
  label: '매도 총잔량 peak',
  defaultParams: { lookback: 20, threshold_pct: 100 },
  ParamForm: DepthPeakForm,
  summarize: (p) => `${p.lookback}일 peak의 ${p.threshold_pct}%`,
};

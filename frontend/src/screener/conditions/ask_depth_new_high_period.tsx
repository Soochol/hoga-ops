import type { CatalogEntry } from './types';
import { DepthPeakPeriodForm } from '../paramForms';

export const ask_depth_new_high_period: CatalogEntry = {
  label: '기간내 매도 총잔량 peak',
  // 실측 기본값 — depth_daily 는 종목당 중위 35거래일 보유(2026-08-20, 358종목).
  // lookback + period 가 그 깊이를 넘으면 기본 상태가 전부 커버리지 부족 배너다.
  defaultParams: { lookback: 5, period: 20, threshold_pct: 100 },
  ParamForm: DepthPeakPeriodForm,
  summarize: (p) => `${p.lookback}일내 ${p.period}일 peak의 ${p.threshold_pct}%`,
};

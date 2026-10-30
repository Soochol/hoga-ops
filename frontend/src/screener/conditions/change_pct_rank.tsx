import { Num } from '../Num';
import type { CatalogEntry, ConditionParams } from './types';

function ChangePctRankForm({ params, onChange }: {
  params: ConditionParams<'change_pct_rank'>;
  onChange: (params: ConditionParams<'change_pct_rank'>) => void;
}) {
  return <div className="condition-form">
    <Num label="당일 등락률 상위" ariaLabel="등락률 순위 상한" suffix="위 이내"
      min={1} max={5000} step={1} value={params.top_n}
      onChange={n => onChange({ top_n: n ?? 100 })} />
  </div>;
}

export const change_pct_rank: CatalogEntry<'change_pct_rank'> = {
  label: '당일 등락률 순위', defaultParams: { top_n: 100 }, ParamForm: ChangePctRankForm,
  help: '선택한 시장·거래소의 전일 종가 대비 등락률이 높은 순서입니다. 키움 상승률 순위를 사용하며 하락 폭·절댓값 순위가 아닙니다. ETF·거래정지·관심종목 필터는 순위 산정 후 적용합니다. 개장 이후 당일만 지원합니다.',
  summarize: p => `당일 · 등락률 상위 ${p.top_n}위 이내`,
};

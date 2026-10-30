import { Num } from '../Num';
import type { CatalogEntry, ConditionParams } from './types';

function TradeValueRankForm({ params, onChange }: {
  params: ConditionParams<'trade_value_rank'>;
  onChange: (params: ConditionParams<'trade_value_rank'>) => void;
}) {
  return <div className="condition-form">
    <Num label="당일 거래대금 상위" ariaLabel="거래대금 순위 상한" suffix="위 이내"
      min={1} max={5000} step={1} value={params.top_n}
      onChange={n => onChange({ top_n: n ?? 100 })} />
  </div>;
}

export const trade_value_rank: CatalogEntry<'trade_value_rank'> = {
  label: '당일 거래대금 순위', defaultParams: { top_n: 100 }, ParamForm: TradeValueRankForm,
  help: '선택한 시장·거래소의 키움 거래대금 순위입니다(관리종목 제외). ETF·거래정지·관심종목 필터는 순위 산정 후 적용합니다. 개장 이후 당일 누적 기준이며 과거·봉별 순위는 지원하지 않습니다.',
  summarize: p => `당일 · 거래대금 상위 ${p.top_n}위 이내`,
};

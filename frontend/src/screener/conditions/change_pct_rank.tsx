import { Num } from '../Num';
import { Select } from '../Select';
import type { CatalogEntry, ConditionParams } from './types';

function ChangePctRankForm({ params, onChange }: {
  params: ConditionParams<'change_pct_rank'>;
  onChange: (params: ConditionParams<'change_pct_rank'>) => void;
}) {
  return <div className="condition-form">
    <Select label="등락률 순위 방향" value={params.direction ?? 'up'}
      options={[["up", "상승률 높은 순"], ["down", "등락률 낮은 순"]]}
      onChange={direction => onChange({ ...params, direction })} />
    <Num label="당일 등락률 상위" ariaLabel="등락률 순위 상한" suffix="위 이내"
      min={1} max={5000} step={1} value={params.top_n}
      onChange={n => onChange({ ...params, top_n: n ?? 100 })} />
  </div>;
}

export const change_pct_rank: CatalogEntry<'change_pct_rank'> = {
  label: '당일 등락률 순위', defaultParams: { top_n: 100 }, ParamForm: ChangePctRankForm,
  help: '선택한 시장·거래소의 전일 종가 대비 등락률이 높은 순서입니다. 상승은 등락률이 높은 순서, 하락은 등락률이 낮은 순서이며 절댓값으로 정렬하지 않습니다. ETF·거래정지·관심종목 필터는 순위 산정 후 적용합니다. 휴장·장전에는 기준일이 확인된 저장 순위를 사용합니다.',
  summarize: p => `당일 · ${p.direction === 'down' ? '하락률' : '등락률'} 상위 ${p.top_n}위 이내`,
};

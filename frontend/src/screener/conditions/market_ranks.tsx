import { Num } from '../Num';
import type { TradeValueRankParams } from '../../api/screener';

const commonHelp = '시장 순위 산정 후 ETF·거래정지·관심종목 필터를 적용하며 원래 순위를 유지합니다. 휴장·장전에는 기준일이 확인된 저장 순위를 사용합니다.';

function rankEntry(label: string, defaults: TradeValueRankParams, maximum: number, help: string) {
  function RankForm({ params, onChange }: { params: TradeValueRankParams; onChange: (params: TradeValueRankParams) => void }) {
    return <div className="condition-form">
      <Num label={`${label} 상위`} ariaLabel={`${label} 상한`} suffix="위 이내"
        min={1} max={maximum} step={1} value={params.top_n}
        onChange={n => onChange({ ...params, top_n: n ?? defaults.top_n })} />
    </div>;
  }
  return { label, defaultParams: defaults, ParamForm: RankForm,
    help: `${help} ${commonHelp}`, summarize: (p: TradeValueRankParams) => `당일 · ${label.replace(/^당일 /, '').replace(/ 순위$/, '')} 상위 ${p.top_n}위 이내` };
}

export const volume_surge_rank = rankEntry('거래량 급증 순위', { top_n: 100 }, 5000,
  '우측 순위와 같은 키움 1분 기준 급증률 순위입니다. 종목별 과거 봉과 비교하는 신고거래량과 별개입니다.');
export const volume_rank = rankEntry('당일 거래량 순위', { top_n: 100 }, 5000,
  '선택한 시장·거래소의 당일 누적 거래량이 많은 순서입니다.');
export const program_net_buy_rank = rankEntry('프로그램 순매수금액 순위', { top_n: 50 }, 5000,
  '선택한 시장·거래소의 프로그램 순매수금액 상위입니다. 순매수 수량이 아니며 양수 순매수 종목만 포함합니다.');
export const institution_net_buy_rank = rankEntry('기관 추정 순매수금액 순위', { top_n: 100 }, 100,
  '정규장 개장 이후의 기관 추정 순매수금액 순위입니다. 최대 100위이며 거래소 지정은 미지원입니다. 선택 거래소는 표시 시세에만 적용됩니다.');
export const foreign_net_buy_rank = rankEntry('외국인 추정 순매수금액 순위', { top_n: 100 }, 100,
  '정규장 개장 이후의 외국인 추정 순매수금액 순위입니다. 최대 100위이며 거래소 지정은 미지원입니다. 선택 거래소는 표시 시세에만 적용됩니다.');

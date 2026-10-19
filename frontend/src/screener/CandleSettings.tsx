import type { ReactNode } from 'react';
import { ConditionTimeframe } from './ConditionControls';
import type { CandleOptions } from '../api/screener';


export function CandleSettings({ params, onChange, children }: {
  params: CandleOptions; onChange: (patch: CandleOptions) => void; children: ReactNode;
}) {
  const timeframe = params.timeframe ?? 'D';
  const minute = timeframe.endsWith('m');
  return <div className="condition-form">
    <ConditionTimeframe value={timeframe} onChange={value => onChange({ timeframe: value })} />
    {children}
    <p className="condition-help">선택 주기의 봉수 기준 · {minute ? 'KRX 정규장' : 'KRX 일봉 코퍼스'}.
      진행 중 봉은 조회 시점까지 반영하며, 조건별 주기는 독립적으로 적용됩니다.</p>
  </div>;
}

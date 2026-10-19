import type { ReactNode } from 'react';
import { ConditionTimeframe } from './ConditionControls';
import type { CandleOptions } from '../api/screener';


export function CandleSettings({ params, onChange, children, rangeControl }: {
  params: CandleOptions; onChange: (patch: CandleOptions) => void; children: ReactNode; rangeControl?: ReactNode;
}) {
  const timeframe = params.timeframe ?? 'D';
  return <div className="condition-form">
    <ConditionTimeframe value={timeframe} onChange={value => onChange({ timeframe: value })}>
      {rangeControl}
    </ConditionTimeframe>
    {children}
  </div>;
}

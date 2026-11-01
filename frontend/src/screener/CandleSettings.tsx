import type { ReactNode } from 'react';
import { ConditionTimeframe } from './ConditionControls';
import type { CandleOptions } from '../api/screener';
import { ConditionFormLayout } from './ConditionFormLayout';


export function CandleSettings({ params, onChange, children, rangeControl }: {
  params: CandleOptions; onChange: (patch: CandleOptions) => void; children: ReactNode; rangeControl?: ReactNode;
}) {
  const timeframe = params.timeframe ?? 'D';
  return <ConditionFormLayout basis={
    <ConditionTimeframe value={timeframe} onChange={value => onChange({ timeframe: value })}>
      {rangeControl}
    </ConditionTimeframe>}>
    {children}
  </ConditionFormLayout>;
}

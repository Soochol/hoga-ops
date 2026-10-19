import type { ReactNode } from 'react';
import { Select } from './Select';
import type { CandleOptions, ScreenerTimeframe } from '../api/screener';


export const CHANGE_REFERENCE_LABELS = {
  previous_day: '전일 종가 대비', previous_bar: '직전 봉 종가 대비', bar_open: '해당 봉 시가 대비',
};

export function timeframeLabel(timeframe: ScreenerTimeframe = 'D'): string {
  return timeframe.endsWith('m') ? `${timeframe.slice(0, -1)}분봉`
    : ({ D: '일봉', W: '주봉', M: '월봉' }[timeframe as 'D' | 'W' | 'M']);
}

export function candleSummary(params: CandleOptions, summary: string): string {
  return `${timeframeLabel(params.timeframe)} · ${summary}${params.include_open_bar === false ? ' · 완료봉' : ''}`;
}

export function CandleSettings({ params, onChange, children }: {
  params: CandleOptions; onChange: (patch: CandleOptions) => void; children: ReactNode;
}) {
  const timeframe = params.timeframe ?? 'D';
  const minute = timeframe.endsWith('m');
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-fg-dim">주기</span>
      <Select label="봉 주기" value={minute ? 'minute' : timeframe}
        options={[[ 'minute', '분' ], ['D', '일'], ['W', '주'], ['M', '월']]}
        onChange={value => onChange({ timeframe: value === 'minute' ? '5m' : value as ScreenerTimeframe })} />
      {minute && <Select label="분봉 간격" value={timeframe}
        options={[1, 3, 5, 10, 15, 30, 60].map(n => [`${n}m` as ScreenerTimeframe, `${n}분`])}
        onChange={value => onChange({ timeframe: value })} />}
    </div>
    {children}
    <label className="inline-flex items-center gap-2 text-sm">
      <input type="checkbox" checked={params.include_open_bar ?? true}
        onChange={event => onChange({ include_open_bar: event.target.checked })} />
      진행 중 봉 포함
    </label>
    <p className="text-2xs text-fg-dim">선택 주기의 봉수 기준 · {minute ? 'KRX 정규장' : 'KRX 일봉 코퍼스'}.
      진행 중 봉은 조회 시점까지 반영하며, 조건별 주기는 독립적으로 적용됩니다.</p>
  </div>;
}

import { useContext } from 'react';
import { CompactSettingsContext, SettingsRow } from '../settings/SettingsRow';
// Shared sign-color legend for the bar indicators (volume, investor net-buy).
// Their bars are colored by SIGN, not configurable — up/buy is --price-up
// (red), down/sell is --price-down (blue). This little key explains that in
// the indicator detail pane, mirroring the chart.

type Props = {
  /** Label for the positive/up direction (e.g. '상승봉', '순매수'). */
  up: string;
  /** Label for the negative/down direction (e.g. '하락봉', '순매도'). */
  down: string;
};

export default function SignColorLegend({ up, down }: Props) {
  const compact = useContext(CompactSettingsContext);
  if (compact) return <div className="indicator-fixed-colors">{([
    [up, 'up', '빨강'], [down, 'down', '파랑'],
  ] as const).map(([label, direction, name]) => <SettingsRow key={direction} label={`${label} ${name}`}>
    <span className="indicator-theme-color"><span aria-hidden="true" style={{ background: `var(--price-${direction})` }} />테마</span>
  </SettingsRow>)}</div>;
  return (
    <div className="flex items-center gap-4 text-xs">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block w-3 h-3 rounded-sm"
          style={{ background: 'var(--price-up)' }}
        />
        <span className="text-fg-dim">{up} 빨강</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block w-3 h-3 rounded-sm"
          style={{ background: 'var(--price-down)' }}
        />
        <span className="text-fg-dim">{down} 파랑</span>
      </span>
    </div>
  );
}

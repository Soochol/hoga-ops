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

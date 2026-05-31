import type { Breakout, BreakoutFilter } from '../api/screener';

interface Props {
  /** The breakout outcome for this row's column. Null when the row carries no
   *  breakout data for this dimension; only renders when `hit` is true. */
  breakout: Breakout | null | undefined;
  /** Short label, e.g. "신고가" or "신고거래량". */
  label: string;
  /** The lookback/period the scan ran with — printed small-caps after the
   *  label so the badge reads "신고가 200·500". */
  filter?: BreakoutFilter;
}

/** Neutral gray breakout tag (신고가 · 신고거래량 공용). DESIGN DECISION: no
 *  price-direction color, no new color token — a breakout is structural, not
 *  directional. Background = --bg-input, small-caps label, days_ago inline,
 *  tooltip = event_date (YYYYMMDD). Only renders on hit. */
export function BreakoutBadge({ breakout, label, filter }: Props) {
  if (!breakout?.hit) return null;
  const periodLabel = filter ? `${filter.lookback}·${filter.period}` : null;
  return (
    <span
      title={breakout.event_date}
      className="inline-flex items-center gap-1 px-xs py-[0.05rem] rounded-md bg-bg-input text-xs text-fg-dim"
    >
      <span className="uppercase tracking-[0.06em] font-medium">
        {label}
        {periodLabel && <span className="ml-1 text-fg-dimmer">{periodLabel}</span>}
      </span>
      <span className="font-mono tabular-nums text-fg-dimmer">{breakout.days_ago}일 전</span>
    </span>
  );
}

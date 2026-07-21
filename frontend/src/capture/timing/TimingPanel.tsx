import { useState } from 'react';
import { useCaptureTimings } from './useCaptureTimings';
import { formatMs, formatPercent, formatEventCount } from './timingFormat';
import { PHASE_TOKEN, PHASE_LABEL, type PhaseKey } from './phaseColors';
import type { TimingSummary } from '../../api/types';

const PHASE_ORDER: PhaseKey[] = [
  'http_fetch',
  'rate_limit',
  'parse',
  'disk_write',
  'backoff',
  'cookie_pause',
  'other',
];

interface Props {
  id: string; // `${code}:${date}`
}

export function TimingPanel({ id }: Props) {
  const summary = useCaptureTimings((s) => s.timings[id]);
  const [expanded, setExpanded] = useState(false);

  if (!summary) return null;

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        <span className="font-data tabular-nums">{formatMs(summary.total_ms)}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`타이밍 상세 ${expanded ? '접기' : '펼치기'}`}
          onClick={() => setExpanded((v) => !v)}
          className="px-1"
        >
          {expanded ? '▴' : '▾'}
        </button>
      </div>

      <StackedBar summary={summary} />

      {!expanded && <PhaseSummaryLine summary={summary} />}
      {expanded && <ExpandedDetail summary={summary} />}
    </div>
  );
}

function StackedBar({ summary }: { summary: TimingSummary }) {
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded gap-px mt-xs"
      role="img"
      aria-label={phaseAriaLabel(summary)}
    >
      {PHASE_ORDER.map((p) => {
        const pct = summary.phase_percentages[p] ?? 0;
        if (pct <= 0) return null;
        return (
          <div
            key={p}
            style={{
              width: `${pct}%`,
              minWidth: 2,
              backgroundColor: PHASE_TOKEN[p],
            }}
          />
        );
      })}
    </div>
  );
}

function PhaseSummaryLine({ summary }: { summary: TimingSummary }) {
  const top3 = [...PHASE_ORDER]
    .sort(
      (a, b) =>
        (summary.phase_percentages[b] ?? 0) - (summary.phase_percentages[a] ?? 0),
    )
    .slice(0, 3)
    .filter((p) => (summary.phase_percentages[p] ?? 0) > 0);

  return (
    <div className="font-data tabular-nums opacity-80 mt-xs">
      {top3.map((p, i) => (
        <span key={p}>
          {PHASE_LABEL[p]} {Math.round(summary.phase_percentages[p])}%
          {i < top3.length - 1 ? ' · ' : ''}
        </span>
      ))}
    </div>
  );
}

function ExpandedDetail({ summary }: { summary: TimingSummary }) {
  const unaccountedPct =
    summary.total_ms > 0 ? (summary.unaccounted_ms / summary.total_ms) * 100 : 0;
  const unaccountedWarn = unaccountedPct > 5;

  return (
    <div className="mt-sm font-data">
      <div className="grid grid-cols-[8rem_5rem_4rem] gap-x-md">
        {PHASE_ORDER.map((p) => (
          <PhaseRow key={p} phase={p} summary={summary} />
        ))}
      </div>
      <div
        className="mt-sm pt-xs opacity-70 tabular-nums"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        pages: {summary.page_count} · events: {formatEventCount(summary.event_count)}
      </div>
      <div className="opacity-70 tabular-nums">
        env: rate_limit {summary.env.rate_limit_s}s · workers {summary.env.max_concurrent}
      </div>
      <div
        className="tabular-nums"
        data-warning={unaccountedWarn ? 'true' : 'false'}
        style={
          unaccountedWarn
            ? { color: 'var(--warn)' }
            : { opacity: 0.7 }
        }
      >
        {unaccountedWarn && '⚠ '}
        unaccounted: {formatMs(summary.unaccounted_ms)} ({formatPercent(unaccountedPct)})
        {unaccountedWarn && ' — 5% 초과는 미계측 블로킹 가능성'}
      </div>
    </div>
  );
}

function PhaseRow({ phase, summary }: { phase: PhaseKey; summary: TimingSummary }) {
  const ms =
    summary.phase_totals_ms[`${phase}_ms` as keyof typeof summary.phase_totals_ms];
  const pct = summary.phase_percentages[phase] ?? 0;
  return (
    <>
      <div style={{ color: PHASE_TOKEN[phase] }}>{PHASE_LABEL[phase]}</div>
      <div className="text-right tabular-nums">{formatMs(ms)}</div>
      <div className="text-right tabular-nums">{formatPercent(pct)}</div>
    </>
  );
}

function phaseAriaLabel(summary: TimingSummary): string {
  return PHASE_ORDER
    .filter((p) => (summary.phase_percentages[p] ?? 0) > 0)
    .map((p) => `${p} ${Math.round(summary.phase_percentages[p])}%`)
    .join(', ');
}

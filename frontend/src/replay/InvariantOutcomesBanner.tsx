import type { DateWarning, ExcludedDate } from '../api/types';

type Props = {
  excluded: ExcludedDate[];
  warnings: DateWarning[];
};

function fmtMD(yyyymmdd: string): string {
  return `${Number(yyyymmdd.slice(4, 6))}/${Number(yyyymmdd.slice(6, 8))}`;
}

/**
 * Surfaces ADR-0020 invariant outcomes attached to the loaded
 * RangeBundle. Two stacked stripes when both lists are non-empty;
 * renders nothing when both are empty so healthy bundles incur zero
 * visual noise.
 *
 *   - `excluded` (error severity, --error tint): Stock-Dates the
 *     backend dropped from `segments` — the user must know why a
 *     requested day isn't on the chart.
 *   - `warnings` (warn severity, --warn tint): Stock-Dates included
 *     in `segments` but with reduced trust (e.g., capture aborted).
 *     The chart still shows them.
 */
export default function InvariantOutcomesBanner({ excluded, warnings }: Props) {
  if (excluded.length === 0 && warnings.length === 0) return null;

  return (
    <div className="flex flex-col">
      {excluded.length > 0 && (
        <div
          role="alert"
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm border-b"
          style={{ background: 'rgba(244,63,94,0.10)', color: 'var(--error)' }}
        >
          <span className="font-medium">데이터 결함으로 제외된 날짜:</span>
          {excluded.map((e) => (
            <span key={e.date} title={e.violations.map((v) => v.message).join('\n')}>
              {fmtMD(e.date)}
              <span className="ml-1 text-xs opacity-70">
                ({e.violations.map((v) => v.invariant_id).join(', ')})
              </span>
            </span>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm border-b"
          style={{ background: 'rgba(245,158,11,0.10)', color: 'var(--warn)' }}
        >
          <span className="font-medium">신뢰도 낮은 날짜:</span>
          {warnings.map((w) => (
            <span key={w.date} title={w.warnings.map((v) => v.message).join('\n')}>
              {fmtMD(w.date)}
              <span className="ml-1 text-xs opacity-70">
                ({w.warnings.map((v) => v.invariant_id).join(', ')})
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

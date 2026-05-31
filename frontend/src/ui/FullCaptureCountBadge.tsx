/**
 * Full Capture 누적 횟수 badge — the single source for rendering a Stock-Date's
 * `full_capture_count`. Shared by the capture queue (CaptureQueueRow) and the
 * inventory detail table (StockDateGroupDetail), which previously each carried
 * a byte-identical copy.
 *
 * The load-bearing rule: **null is a lower bound, not "unknown"**. Every
 * Stock-Date on disk was captured at least once by construction, so a legacy
 * `meta.json` written before the counter existed (null) is rendered as a faint
 * `×1` with a tooltip that stays honest about the missing record.
 *
 * - `undefined` → no row in /api/stock-dates yet → `—` (first-ever capture
 *   attempt). Only reachable from the queue, where a (code, date) can be in the
 *   `queued` phase with nothing on disk; the inventory table's
 *   `full_capture_count` is `number | null`, so it never hits this branch.
 * - `null`      → legacy meta without the counter → faint `×1`, "≥1로 간주" tooltip
 * - `1`         → real ×1                         → faint `×1`
 * - `≥2`        → real ×N                         → `×N`, standard tone
 */
export function FullCaptureCountBadge({ n }: { n: number | null | undefined }) {
  if (n === undefined) {
    return <span className="text-fg-dimmer">—</span>;
  }
  const effective = n ?? 1;
  const tone =
    effective >= 2
      ? 'text-fg-dim border-[var(--fg-dim)]'
      : 'text-fg-dimmer border-[var(--fg-dimmer)]';
  const title = n === null ? 'Full Capture 횟수 미기록 (≥1로 간주)' : `Full Capture 누적 ${n}회`;
  return (
    <span
      title={title}
      className={`text-badge rounded-md px-[0.15rem] border ${tone} font-mono tabular-nums`}
    >
      ×{effective}
    </span>
  );
}

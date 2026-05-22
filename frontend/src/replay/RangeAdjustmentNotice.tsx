type Props = {
  requestedFrom: string;
  requestedTo: string;
  actualFirst: string;
  actualLast: string;
  onAdjust: () => void;
  onDismiss: () => void;
};

function fmtMD(yyyymmdd: string): string {
  return `${Number(yyyymmdd.slice(4, 6))}/${Number(yyyymmdd.slice(6, 8))}`;
}

/**
 * Surfaces partial-inventory boundary mismatch under the Toolbar
 * (plan-eng-review T2). Renders nothing when requested == actual.
 */
export default function RangeAdjustmentNotice({
  requestedFrom,
  requestedTo,
  actualFirst,
  actualLast,
  onAdjust,
  onDismiss,
}: Props) {
  const fromSkipped = requestedFrom !== actualFirst;
  const toSkipped = requestedTo !== actualLast;
  if (!fromSkipped && !toSkipped) return null;

  const parts: string[] = [];
  if (fromSkipped) {
    parts.push(
      `fromDate (${fmtMD(requestedFrom)})는 아직 캡처 안 됨. 실제 표시: ${fmtMD(actualFirst)}부터`,
    );
  }
  if (toSkipped) {
    parts.push(
      `toDate (${fmtMD(requestedTo)})는 아직 캡처 안 됨. 실제 표시: ${fmtMD(actualLast)}까지`,
    );
  }

  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-2 bg-bg-card border-b text-fg-dim text-sm"
    >
      <span>{parts.join(' / ')}</span>
      <button
        type="button"
        onClick={onAdjust}
        className="ml-2 text-accent hover:underline"
      >
        실제 범위로 조정
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="ml-auto text-fg-dim hover:text-fg"
      >
        ✕
      </button>
    </div>
  );
}

import { Link } from 'react-router';
import { useCaptureQueue } from '../capture/useCaptureQueue';

export function CaptureStatusPill() {
  const { queue } = useCaptureQueue();
  if (queue === undefined) return null;
  const activeCount = queue.active.length;
  const queuedCount = queue.queued.length;
  if (!queue.paused && activeCount === 0 && queuedCount === 0) return null;

  const paused = queue.paused;
  const label = paused ? 'PAUSED' : 'CAPTURING';
  const dotColor = paused ? 'var(--warn)' : 'var(--accent)';
  const dotAnim = paused ? 'none' : 'capture-pulse 1.5s ease-in-out infinite';

  const stats = paused
    ? 'Cookie expired — click to resume'
    : `${activeCount} capturing · ${queuedCount} queued`;

  return (
    <Link
      to="/capture"
      className="flex flex-col gap-1 py-sm px-md bg-bg-card border rounded-md no-underline"
    >
      <span className="flex items-center gap-1.5">
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, animation: dotAnim }} />
        <span
          className="font-semibold text-xs tracking-[0.08em]"
          style={{ color: paused ? 'var(--warn)' : 'var(--accent)' }}
        >{label}</span>
      </span>
      <span
        className="font-medium text-xs font-mono"
        style={{ color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums' }}
      >{stats}</span>
    </Link>
  );
}

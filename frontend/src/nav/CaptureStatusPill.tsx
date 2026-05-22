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
      style={{
        display: 'flex', flexDirection: 'column', gap: 4,
        padding: '8px 12px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        textDecoration: 'none',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, animation: dotAnim }} />
        <span style={{
          font: '600 9.5px "Geist Sans", sans-serif',
          letterSpacing: '0.08em',
          color: paused ? 'var(--warn)' : 'var(--accent)',
        }}>{label}</span>
      </span>
      <span style={{
        font: '500 10px "Geist Mono", monospace',
        color: 'var(--fg-dim)',
        fontVariantNumeric: 'tabular-nums',
      }}>{stats}</span>
    </Link>
  );
}

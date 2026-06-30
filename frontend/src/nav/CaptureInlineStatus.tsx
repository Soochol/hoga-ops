import { Link } from 'react-router';
import { useCaptureQueue } from '../capture/useCaptureQueue';

export function CaptureInlineStatus() {
  const { queue } = useCaptureQueue();
  if (queue === undefined) return null;

  const activeCount = queue.active.length;
  const queuedCount = queue.queued.length;
  if (!queue.paused && activeCount === 0 && queuedCount === 0) return null;

  const paused = queue.paused;
  const label = paused ? 'paused' : `${activeCount} capturing · ${queuedCount} queued`;
  const dotColor = paused ? 'var(--warn)' : 'var(--accent)';
  const dotAnim = paused ? 'none' : 'capture-pulse 1.5s ease-in-out infinite';

  return (
    <Link
      to="/capture"
      className="inline-flex h-full items-center gap-xs whitespace-nowrap text-xs font-semibold text-fg-dim no-underline hover:text-fg"
    >
      <span
        aria-hidden="true"
        className="rounded-full"
        style={{ width: 6, height: 6, background: dotColor, animation: dotAnim }}
      />
      <span>{label}</span>
    </Link>
  );
}

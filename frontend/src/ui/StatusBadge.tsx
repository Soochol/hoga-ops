import type { ReactNode } from 'react';

/**
 * Bordered status pill — the shared primitive for the project's micro-badges
 * (fail_streak 재시도, full-capture ×N, and the capture-queue force/attempt/
 * inventory tags). Centralizes the badge shell
 * `text-badge rounded-md px-[0.15rem] border … font-mono tabular-nums` that was
 * previously inlined byte-by-byte across FailStreakCell, FullCaptureCountBadge,
 * and CaptureQueueRow — one place to retune padding / radius / tone so the
 * variants can never silently drift apart again.
 *
 * `tone` selects the border+text colour pair. `title` is the hover tooltip;
 * `ariaLabel` the screen-reader text (use when the visible children are terse,
 * e.g. "N/5"). `className` carries per-site extras such as `ml-1.5` spacing.
 *
 * Note on `px-[0.15rem]` (~2.4px): DESIGN.md has no spacing token this small
 * (the nearest, `xs`, is 10.5px), so the literal is intentional and now lives
 * in exactly one place — swap it here if a token is ever added.
 */
const TONE_CLASS = {
  warn: 'border-[var(--warn)] text-[var(--warn)]',
  error: 'border-[var(--error)] text-[var(--error)]',
  dim: 'border-[var(--fg-dim)] text-fg-dim',
  dimmer: 'border-[var(--fg-dimmer)] text-fg-dimmer',
} as const;

export type StatusBadgeTone = keyof typeof TONE_CLASS;

export function StatusBadge({
  tone,
  title,
  ariaLabel,
  className = '',
  children,
}: {
  tone: StatusBadgeTone;
  title?: string;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      aria-label={ariaLabel}
      className={`text-badge rounded-md px-[0.15rem] border ${TONE_CLASS[tone]} font-mono tabular-nums ${className}`.trim()}
    >
      {children}
    </span>
  );
}

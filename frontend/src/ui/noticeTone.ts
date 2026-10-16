import type { CSSProperties } from 'react';

export type NoticeTone = 'neutral' | 'success' | 'warn' | 'error' | 'accent';

/** Shared semantic colours for inline notices, chips and toast borders. */
export function noticeColors(tone: NoticeTone) {
  if (tone === 'neutral') return { foreground: 'var(--fg-dim)', background: 'var(--bg-input)', border: 'var(--border)' };
  const color = tone === 'accent' ? 'accent' : tone;
  return {
    foreground: `var(--${color})`,
    background: tone === 'accent' ? 'var(--tint-selection)' : `var(--tint-${color})`,
    border: `color-mix(in srgb, var(--${color}) 30%, transparent)`,
  };
}

export function noticeStyle(tone: NoticeTone): CSSProperties {
  const colors = noticeColors(tone);
  return { color: colors.foreground, background: colors.background, borderColor: colors.border };
}

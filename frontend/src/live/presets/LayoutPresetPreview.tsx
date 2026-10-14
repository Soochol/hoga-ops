import type { LiveLayoutPresetPayload } from '../../api/liveLayoutPresets';

/** Draw stored rectangles without mounting charts or changing the workspace. */
export function LayoutPresetPreview({ payload }: { payload: LiveLayoutPresetPayload }) {
  const rects = payload.windows.flatMap(window => {
    if (!window || typeof window !== 'object' || !('rect' in window)) return [];
    const rect = window.rect;
    if (!rect || typeof rect !== 'object') return [];
    const { x, y, w, h } = rect as Record<string, unknown>;
    return typeof x === 'number' && typeof y === 'number' && typeof w === 'number' && typeof h === 'number'
      && [x, y, w, h].every(Number.isFinite) && x >= 0 && y >= 0 && w > 0 && h > 0 ? [{ x, y, w, h }] : [];
  });
  const width = Math.max(1, ...rects.map(rect => rect.x + rect.w));
  const height = Math.max(1, ...rects.map(rect => rect.y + rect.h));
  return <span className="flex shrink-0 items-center gap-2 text-xs text-fg-dim">
    <svg aria-hidden width="40" height="26" viewBox="0 0 100 64" className="rounded border border-border bg-bg-subtle">
      {rects.map((rect, index) => <rect key={index} x={rect.x / width * 96 + 2} y={rect.y / height * 60 + 2}
        width={Math.max(1, rect.w / width * 96 - 2)} height={Math.max(1, rect.h / height * 60 - 2)}
        rx="2" fill="var(--tint-selection)" stroke="var(--fg-dim)" />)}
    </svg>
    <span>{payload.windows.length}개 창</span>
  </span>;
}

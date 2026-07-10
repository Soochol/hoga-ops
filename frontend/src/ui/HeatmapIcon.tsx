/**
 * Shared heatmap glyph — a 2×2 grid of tiles (the heatmap board motif).
 * Fill = currentColor (a *shape* signal, NOT a second accent — see DESIGN.md
 * color discipline, consistent with the Right Rail heart/bookmark icons).
 * Sizing is via `className` (e.g. "w-[1.125em] h-[1.125em]").
 */
export function HeatmapIcon({ filled, className }: { filled?: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

/**
 * Shared funnel glyph for the Screener rail item. Fill = currentColor (a *shape*
 * signal, NOT a second accent — mirrors HeartIcon / DESIGN.md color discipline).
 * Sizing is via `className` (e.g. "w-[1.125em] h-[1.125em]").
 */
export function FunnelIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 4.5h18l-7 8v6.5l-4 2v-8.5z" />
    </svg>
  );
}

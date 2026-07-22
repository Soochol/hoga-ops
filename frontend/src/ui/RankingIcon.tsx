/**
 * Shared podium/ranking glyph for the 순위 rail item. Three ascending bars.
 * Fill = currentColor (a *shape* signal, NOT a second accent — mirrors
 * FunnelIcon / HeartIcon / DESIGN.md color discipline). Size via `className`.
 */
export function RankingIcon({ filled, className }: { filled: boolean; className?: string }) {
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
      {/* 오름차순 3-막대 시상대: 좌 중 우 = 낮음·높음·중간 */}
      <rect x="3" y="13" width="4.5" height="7" rx="0.5" />
      <rect x="9.75" y="8" width="4.5" height="12" rx="0.5" />
      <rect x="16.5" y="11" width="4.5" height="9" rx="0.5" />
    </svg>
  );
}

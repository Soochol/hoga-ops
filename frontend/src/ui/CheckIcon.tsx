/**
 * Filled-circle check icon — the shared "checkbox" glyph for modal rows
 * (보조지표 IndicatorPanel 카테고리, 관심종목 편집 entry 선택). Checked = accent-filled
 * circle + dark check (teal = UI state, per DESIGN.md color discipline);
 * unchecked = hollow dimmer ring with a dim check. Extracted from
 * IndicatorPanel so consumers share one shape instead of copying the SVG.
 */
export function CheckIcon({ filled, size = 18 }: { filled: boolean; size?: number }) {
  if (filled) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="var(--accent)" />
        <path
          d="M7.5 12.5l3 3 6-6"
          stroke="var(--accent-fg, #0A0A12)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="var(--fg-dimmer)"
        strokeWidth="1.5"
      />
      <path
        d="M7.5 12.5l3 3 6-6"
        stroke="var(--fg-dimmer)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

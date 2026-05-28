/**
 * Compact display labels for the 거래원 sidebar's narrow broker column.
 *
 * The "증권" suffix carries no information (every Korean member firm has
 * it) so we drop it and keep results ≤4 chars for clean rendering. New
 * canonical names added to backend `hoga.broker_names._CANONICAL`
 * usually need no entry here — the automatic "strip 증권, cap at 4
 * chars" rule covers the common case. Add an explicit override only
 * when the rule produces an awkward label (extra abbreviation needed,
 * or no `증권` suffix to strip from a >4-char name).
 */

const DISPLAY_OVERRIDES: Record<string, string> = {
  '모건스탠리증권': '모건스탠',
  '코리아에셋': '코리아',
};

/** Return the compact ≤4-char label for *canonicalName*. */
export function brokerDisplayShort(canonicalName: string): string {
  const override = DISPLAY_OVERRIDES[canonicalName];
  if (override !== undefined) return override;
  const stripped = canonicalName.endsWith('증권')
    ? canonicalName.slice(0, -2)
    : canonicalName;
  return stripped.length > 4 ? stripped.slice(0, 4) : stripped;
}

/**
 * Compact display labels for the 거래원 sidebar's narrow broker column.
 *
 * The "증권" suffix carries no information (every Korean member firm has
 * it) so we drop it and keep results ≤4 chars for clean rendering. The
 * canonical name is kept on the entry for tooltips so users can
 * disambiguate hovered rows.
 *
 * Keys are the **canonical** form (see backend `hoga.broker_names`); the
 * canonical-to-display mapping is presentation-only and lives here.
 * When a new entry is added to backend `_CANONICAL`, add a sibling
 * entry here if the canonical name is longer than 4 chars.
 */

const DISPLAY_SHORT: Record<string, string> = {
  '신한투자증권': '신한투자',
  '한국투자증권': '한국투자',
  '미래에셋증권': '미래에셋',
  '삼성증권': '삼성',
  '토스증권': '토스',
  '키움증권': '키움',
  'NH투자증권': 'NH투자',
  'KB증권': 'KB',
  '유안타증권': '유안타',
  '신영증권': '신영',
  '모건스탠리증권': '모건스탠',
  'JP모간': 'JP모간',
  '코리아에셋': '코리아',
};

/** Return the compact ≤4-char label for *canonicalName*.
 *  Falls back to the canonical string truncated to 4 chars when no
 *  explicit mapping exists. */
export function brokerDisplayShort(canonicalName: string): string {
  const mapped = DISPLAY_SHORT[canonicalName];
  if (mapped !== undefined) return mapped;
  return canonicalName.length > 4 ? canonicalName.slice(0, 4) : canonicalName;
}

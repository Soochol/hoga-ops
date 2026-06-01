/** change_pct cell — sign-based KRX color (DESIGN DECISION): >0 text-price-up
 *  (red), <0 text-price-down (blue), 0 neutral --fg-dim. ▲▼ glyph for
 *  colorblind redundancy. null → "—". NOT western green=up. */
export function ChangeCell({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-fg-dim">—</span>;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const cls = dir === 'up' ? 'text-price-up' : dir === 'down' ? 'text-price-down' : 'text-fg-dim';
  const glyph = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
  return <span className={cls}>{glyph}{glyph && ' '}{pct > 0 ? '+' : ''}{pct.toFixed(2)}%</span>;
}

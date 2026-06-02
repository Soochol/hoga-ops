/** change_pct cell — sign-based KRX color (DESIGN DECISION): >0 text-price-up
 *  (red), <0 text-price-down (blue), 0 neutral --fg-dim. ▲▼ glyph for
 *  colorblind redundancy. null → "—". NOT western green=up. */
import { priceDirClass } from '../ui/priceDir';

export function ChangeCell({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-fg-dim">—</span>;
  const cls = priceDirClass(pct);
  const glyph = pct > 0 ? '▲' : pct < 0 ? '▼' : '';
  return <span className={cls}>{glyph}{glyph && ' '}{pct > 0 ? '+' : ''}{pct.toFixed(2)}%</span>;
}

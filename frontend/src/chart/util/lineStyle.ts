import { LineStyle as LwcLineStyle } from 'lightweight-charts';
import type { LineStyle } from '../drawing/types';

/**
 * Map the app's drawing `LineStyle` union ('solid' | 'dashed' | 'dotted') to the
 * numeric `lightweight-charts` `LineStyle` enum used by series/price-line options.
 * Single source so every price-line style picker (총잔량·호가비 현재값 수평선 등)
 * shares one conversion instead of re-deriving the 0/1/2 magic numbers.
 *
 *   solid  → 0 (LineStyle.Solid)
 *   dotted → 1 (LineStyle.Dotted)
 *   dashed → 2 (LineStyle.Dashed)
 */
export function toLwcLineStyle(style: LineStyle): LwcLineStyle {
  switch (style) {
    case 'dotted':
      return LwcLineStyle.Dotted;
    case 'dashed':
      return LwcLineStyle.Dashed;
    case 'solid':
    default:
      return LwcLineStyle.Solid;
  }
}

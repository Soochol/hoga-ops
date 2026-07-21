import { describe, it, expect } from 'vitest';
import { CHART_LAYOUT_OPTIONS, CHART_TIMESCALE_OPTIONS, CHART_CROSSHAIR_LINE_WIDTH } from '../../src/util/chartScale';
import { CANVAS_FONT_STACK, RENDERED_ROOT_PX } from '../../src/styles/design-tokens';

// 캔버스 상수는 RENDERED_ROOT_PX(밀도 다이얼 미러)에서 파생된다 — 기대값도
// 같은 소스에서 유도해 다이얼 변경 시 마법수로 깨지지 않게 한다.
const DENSITY = RENDERED_ROOT_PX / 16;

describe('chartScale', () => {
  // fontSize is PINNED, not derived — see the note on CHART_LAYOUT_OPTIONS.
  // The object was spread at the wrong nesting level until 2026-07-21, so the
  // density-derived 14 never reached the canvas and 12 is what shipped.
  // Adopting 14 coarsens the price-axis tick grid, so it is deferred to its own
  // decision rather than riding along with a typeface change.
  it('pins layout.fontSize to the library default 12 (canvas density deferred)', () => {
    expect(CHART_LAYOUT_OPTIONS.fontSize).toBe(12);
    expect(CHART_LAYOUT_OPTIONS.fontSize).not.toBe(Math.round(12 * DENSITY));
  });

  it('sets layout.fontFamily to the shared canvas stack (never the library default)', () => {
    expect(CHART_LAYOUT_OPTIONS.fontFamily).toBe(CANVAS_FONT_STACK);
    expect(CHART_LAYOUT_OPTIONS.fontFamily).toMatch(/Pretendard/);
  });

  it('keeps crosshair line width at 1px for sharpness (no scaling)', () => {
    expect(CHART_CROSSHAIR_LINE_WIDTH).toBe(1);
  });

  it('derives timeScale right-offset from the density dial (library default 12 scaled)', () => {
    expect(CHART_TIMESCALE_OPTIONS.rightOffset).toBe(Math.round(12 * DENSITY));
  });

  it('keeps timeScale bar-spacing at the library default for dense candles', () => {
    expect(CHART_TIMESCALE_OPTIONS.barSpacing).toBe(6);
  });
});

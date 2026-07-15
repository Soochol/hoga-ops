import { describe, it, expect } from 'vitest';
import { CHART_LAYOUT_OPTIONS, CHART_TIMESCALE_OPTIONS, CHART_CROSSHAIR_LINE_WIDTH } from '../../src/util/chartScale';
import { RENDERED_ROOT_PX } from '../../src/styles/design-tokens';

// 캔버스 상수는 RENDERED_ROOT_PX(밀도 다이얼 미러)에서 파생된다 — 기대값도
// 같은 소스에서 유도해 다이얼 변경 시 마법수로 깨지지 않게 한다.
const DENSITY = RENDERED_ROOT_PX / 16;

describe('chartScale', () => {
  it('derives layout.fontSize from the density dial (library default 12 scaled)', () => {
    expect(CHART_LAYOUT_OPTIONS.fontSize).toBe(Math.round(12 * DENSITY));
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

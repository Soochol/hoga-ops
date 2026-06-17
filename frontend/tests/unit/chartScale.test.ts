import { describe, it, expect } from 'vitest';
import { CHART_LAYOUT_OPTIONS, CHART_TIMESCALE_OPTIONS, CHART_CROSSHAIR_LINE_WIDTH } from '../../src/util/chartScale';

describe('chartScale', () => {
  it('exposes layout.fontSize at the 1.25x density value (15px)', () => {
    expect(CHART_LAYOUT_OPTIONS.fontSize).toBe(15);
  });

  it('keeps crosshair line width at 1px for sharpness (no scaling)', () => {
    expect(CHART_CROSSHAIR_LINE_WIDTH).toBe(1);
  });

  it('scales timeScale right-offset by 1.25 from library default', () => {
    expect(CHART_TIMESCALE_OPTIONS.rightOffset).toBe(15);
  });

  it('keeps timeScale bar-spacing at the library default for dense candles', () => {
    expect(CHART_TIMESCALE_OPTIONS.barSpacing).toBe(6);
  });
});

import { describe, it, expect } from 'vitest';
import { CrosshairMode } from 'lightweight-charts';
import {
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
  CHART_CROSSHAIR_LINE_WIDTH,
  chartCrosshairOptions,
} from '../../src/util/chartScale';
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
  //
  // ⚠️ 2026-08-07, 다이얼이 1.0× 로 내려가며 **"핀이다" 를 재는 축이 관측 불가능해졌다**:
  // 파생값 `round(12 × 1.0)` 이 핀 값 12 와 같아져 둘을 값으로 구별할 수 없다. 그래서
  // `not.toBe` 를 무조건 걸면 자기 자신과 다르기를 요구하는 항상 빨간 단언이 된다.
  // 지우지 않고 **밀도 조건 뒤로 물린다** — 다이얼이 1 이 아닌 값으로 움직이는 순간
  // (Comfortable 1.125× / Cozy 1.25×) 이 가드는 스스로 되살아난다.
  // 이 조건절은 "지금 통과 중" 이 아니라 "지금은 잴 수 없음" 을 뜻한다.
  it('pins layout.fontSize to the library default 12 (canvas density deferred)', () => {
    expect(CHART_LAYOUT_OPTIONS.fontSize).toBe(12);
    if (DENSITY !== 1) {
      expect(CHART_LAYOUT_OPTIONS.fontSize).not.toBe(Math.round(12 * DENSITY));
    }
  });

  it('sets layout.fontFamily to the shared canvas stack (never the library default)', () => {
    expect(CHART_LAYOUT_OPTIONS.fontFamily).toBe(CANVAS_FONT_STACK);
    expect(CHART_LAYOUT_OPTIONS.fontFamily).toMatch(/Pretendard/);
  });

  it('keeps crosshair line width at 1px for sharpness (no scaling)', () => {
    expect(CHART_CROSSHAIR_LINE_WIDTH).toBe(1);
  });

  it('puts the crosshair label chip on BOTH axes and keeps Normal tracking', () => {
    // vertLine 이 시간축 라벨, horzLine 이 가격축 라벨이다 — 한쪽만 걸면 절반만
    // 고쳐지고, 어긋난 두 색이 같은 화면에 뜬다.
    const opts = chartCrosshairOptions('#3182f6');
    expect(opts.vertLine?.labelBackgroundColor).toBe('#3182f6');
    expect(opts.horzLine?.labelBackgroundColor).toBe('#3182f6');
    expect(opts.mode).toBe(CrosshairMode.Normal);
  });

  it('never bakes in a color — the chip must come from the caller (theme token)', () => {
    // 상수였다면 앱 부팅 시점 테마에 얼어붙는다(이 모듈 헤더의 경고). 두 번
    // 호출해 서로 다른 값이 나오는지 재면 리터럴 하드코딩이 걸린다.
    expect(chartCrosshairOptions('#f0b429').horzLine?.labelBackgroundColor).toBe('#f0b429');
    expect(chartCrosshairOptions('#1f6f54').horzLine?.labelBackgroundColor).toBe('#1f6f54');
  });

  it('derives timeScale right-offset from the density dial (library default 12 scaled)', () => {
    expect(CHART_TIMESCALE_OPTIONS.rightOffset).toBe(Math.round(12 * DENSITY));
  });

  it('keeps timeScale bar-spacing at the library default for dense candles', () => {
    expect(CHART_TIMESCALE_OPTIONS.barSpacing).toBe(6);
  });
});

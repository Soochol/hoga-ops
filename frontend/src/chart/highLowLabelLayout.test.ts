import { describe, it, expect } from 'vitest';
import {
  estimateLabelWidth,
  placeExtremeLabel,
  type AvoidRect,
} from './highLowLabelLayout';

describe('placeExtremeLabel', () => {
  // pane 760×180, LABEL_EDGE_PAD_PX=6, LABEL_HEIGHT_PX=16. above 앵커=라벨 top,
  // below 앵커=라벨 bottom. 라벨 x=440, 텍스트 30자 → x 구간 대략 [337,543].
  const HIGH_TEXT = '60,000원 (-13.59%, 06.10 09:30)';
  const LOW_TEXT = '58,700원 (+2.10%, 06.10 09:30)';
  const w = estimateLabelWidth;
  const highLabelBox = (y: number) => ({ top: y, bottom: y + 16 });
  const lowLabelBox = (y: number) => ({ top: y - 16, bottom: y });
  // 도킹 wall 칩 rect 근사: 선 y 위 {top: lineY-15, bottom: lineY-2} × 주어진 x 구간.
  const wallRect = (lineY: number, left = 300, right = 600): AvoidRect => ({
    top: lineY - 3 - 11 - 1,
    bottom: lineY - 3 + 1,
    left,
    right,
  });
  const disjoint = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
    a.bottom <= b.top || a.top >= b.bottom;

  it('pins the high label to the top edge regardless of the dot y', () => {
    // dot 이 pane 아래쪽(120)에 있어도 라벨은 상단 가장자리에 고정.
    expect(placeExtremeLabel('above', 140, 120, w('59,300원 (-3.90%, 06.09 10:00)'), 760, 180)).toMatchObject({
      place: 'above',
      y: 6,
    });
  });

  it('pins the low label to the bottom edge regardless of the dot y', () => {
    expect(placeExtremeLabel('below', 140, 40, w('58,900원 (+1.20%, 06.09 10:00)'), 760, 180)).toMatchObject({
      place: 'below',
      y: 174,
    });
  });

  it('keeps labels inside the horizontal pane edges', () => {
    const left = placeExtremeLabel('above', 20, 80, w('59,300원 (-3.90%, 06.09 10:00)'), 760, 180);
    const right = placeExtremeLabel('below', 750, 80, w('58,900원 (+1.20%, 06.09 10:00)'), 760, 180);

    expect(left.x).toBeGreaterThan(20);
    expect(right.x).toBeLessThan(750);
  });

  it('pushes a top-pinned high label down past an overlapping rect near the top edge', () => {
    // wall line 20 → rect y {5,18} overlaps the top-edge high box {6,22}. 라벨은 아래로 양보.
    const high = placeExtremeLabel('above', 440, 60, w(HIGH_TEXT), 760, 180, [wallRect(20)]);

    expect(high.place).toBe('above');
    expect(high.y).toBeGreaterThan(6);
    expect(disjoint(highLabelBox(high.y), wallRect(20))).toBe(true);
  });

  it('pushes a bottom-pinned low label up past an overlapping rect near the bottom edge', () => {
    // wall line 170 → rect y {155,168} overlaps the bottom-edge low box {158,174}. 라벨은 위로 양보.
    const low = placeExtremeLabel('below', 440, 120, w(LOW_TEXT), 760, 180, [wallRect(170)]);

    expect(low.place).toBe('below');
    expect(low.y).toBeLessThan(174);
    expect(disjoint(lowLabelBox(low.y), wallRect(170))).toBe(true);
  });

  it('ignores a rect that is horizontally disjoint from the label (2D check, not y-only)', () => {
    // 같은 y 대역(상단 가장자리)이지만 x 구간이 라벨(≈[337,543])과 안 겹치는 칩 —
    // 우측에 도킹된 wall 라벨이 좌측 극값 라벨을 밀어내던 유령 push 의 회귀 가드.
    const high = placeExtremeLabel('above', 440, 60, w(HIGH_TEXT), 760, 180, [wallRect(20, 600, 700)]);
    expect(high.y).toBe(6);
  });

  it('leaves the label at the edge when no rect is near it', () => {
    // wall line 96 → rect y {81,94} sits mid-pane, far from the top-edge high box {6,22}.
    const high = placeExtremeLabel('above', 440, 60, w(HIGH_TEXT), 760, 180, [wallRect(96)]);
    expect(high.y).toBe(6);
  });

  it('reverts to the edge when avoidance would push the label deeper than the shift cap', () => {
    // 하단 가장자리부터 pane 중간 위까지 이어지는 큰 회피 rect — 이를 다 피하려면
    // 116px(> 180×0.3=54) 밀려 pane 중간에 뜬다. 겹침을 감수하고 가장자리(174) 복귀.
    const low = placeExtremeLabel(
      'below', 440, 120, w(LOW_TEXT), 760, 180,
      [{ top: 60, bottom: 172, left: 300, right: 600 }],
    );
    expect(low.y).toBe(174);
  });

  it('falls back to the original point before pane size is known', () => {
    expect(placeExtremeLabel('above', 20, 12, w('59,300원 (-3.90%, 06.09 10:00)'), 0, 0)).toEqual({
      place: 'above',
      x: 20,
      y: 12,
    });
  });
});

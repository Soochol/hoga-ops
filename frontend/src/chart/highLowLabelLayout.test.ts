import { describe, it, expect } from 'vitest';
import {
  estimateLabelWidth,
  placeExtremeLabel,
  type AvoidRect,
} from './highLowLabelLayout';

describe('placeExtremeLabel', () => {
  // pane 760×180, LABEL_EDGE_PAD_PX=6, LABEL_HEIGHT_PX=16, LABEL_AVOID_GAP_PX=2.
  // above 앵커=라벨 top, below 앵커=라벨 bottom. 라벨 x=440, 텍스트 17~18자
  // → x 구간 대략 [376,504].
  const HIGH_TEXT = '60,000원 (-13.59%)';
  const LOW_TEXT = '58,700원 (+2.10%)';
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
    expect(placeExtremeLabel('above', 140, 120, w('59,300원 (-3.90%)'), 760, 180)).toMatchObject({
      place: 'above',
      y: 6,
    });
  });

  it('pins the low label to the bottom edge regardless of the dot y', () => {
    expect(placeExtremeLabel('below', 140, 40, w('58,900원 (+1.20%)'), 760, 180)).toMatchObject({
      place: 'below',
      y: 174,
    });
  });

  it('keeps labels inside the horizontal pane edges', () => {
    const left = placeExtremeLabel('above', 20, 80, w('59,300원 (-3.90%)'), 760, 180);
    const right = placeExtremeLabel('below', 750, 80, w('58,900원 (+1.20%)'), 760, 180);

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
    // 같은 y 대역(상단 가장자리)이지만 x 구간이 라벨(≈[376,504])과 안 겹치는 칩 —
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

  it('stops a pushed high label at the candle line instead of covering the extreme bar', () => {
    // 레전드 행이 두꺼워(bottom 56) 회피 push 만 보면 앵커가 58 → 박스 {58,74} 로 dot(60)
    // 아래, 즉 **캔들 안**에 놓인다. 캔들 상한이 이를 42 로 되돌린다: 박스 {42,58} 이고
    // bottom 58 = dot 60 − gap 2. 이 클램프가 없으면 여기서 58 이 나온다.
    const legend: AvoidRect = { top: 0, bottom: 56, left: 0, right: 700 };
    const high = placeExtremeLabel('above', 440, 60, w(HIGH_TEXT), 760, 180, [legend]);

    expect(high.y).toBe(42);
    expect(highLabelBox(high.y).bottom).toBeLessThanOrEqual(60 - 2);
    // 대가는 레전드와의 겹침 — "자리가 없으면 레전드를 덮고 캔들을 살린다"(2026-08-23 결정).
    expect(disjoint(highLabelBox(high.y), legend)).toBe(false);
  });

  it('stops a pushed low label at the candle line (mirror of the high case)', () => {
    // 하단 회피 rect(top 124) 만 보면 앵커 122 → 박스 {106,122} 로 dot(120) 위, 캔들 안.
    // 캔들 상한이 138 로 되돌린다: 박스 {122,138}, top 122 = dot 120 + gap 2.
    const legend: AvoidRect = { top: 124, bottom: 180, left: 0, right: 700 };
    const low = placeExtremeLabel('below', 440, 120, w(LOW_TEXT), 760, 180, [legend]);

    expect(low.y).toBe(138);
    expect(lowLabelBox(low.y).top).toBeGreaterThanOrEqual(120 + 2);
  });

  it('leaves the edge anchor alone when it already clears the candle', () => {
    // dot 이 pane 한가운데(90)면 상단 가장자리 박스 {6,22} 는 이미 캔들 위 — 상한이
    // 라벨을 캔들 쪽으로 **끌어내리지 않는다**(클램프는 한 방향 상한이지 재배치가 아니다).
    expect(placeExtremeLabel('above', 440, 90, w(HIGH_TEXT), 760, 180).y).toBe(6);
  });

  it('returns to the edge when the candle leaves no room at all (documented limit)', () => {
    // 극값 봉이 pane 가장자리에 바싹 붙으면(dot y=10) 상한(−8)이 pane 밖이라 가장자리(6)로
    // 복귀하고 라벨이 그 봉을 덮는다. 어떤 배치도 겹침을 피할 수 없는 구간이므로 의도다.
    expect(placeExtremeLabel('above', 440, 10, w(HIGH_TEXT), 760, 180).y).toBe(6);
  });

  it('falls back to the original point before pane size is known', () => {
    expect(placeExtremeLabel('above', 20, 12, w('59,300원 (-3.90%)'), 0, 0)).toEqual({
      place: 'above',
      x: 20,
      y: 12,
    });
  });
});

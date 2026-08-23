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
  /** 배치된 라벨(중심 x·앵커 y)이 rect 와 **2D** 로 겹치는가 — 슬라이드 결과 판정용. */
  const overlaps2d = (
    p: { x: number; y: number; place: 'above' | 'below' }, text: string, r: AvoidRect,
  ) => {
    const half = w(text) / 2;
    const box = p.place === 'above' ? highLabelBox(p.y) : lowLabelBox(p.y);
    return p.x - half < r.right && r.left < p.x + half
      && box.top < r.bottom && r.top < box.bottom;
  };

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
    // rect 가 **pane 전폭**이라 가로 슬라이드로도 빠져나갈 곳이 없다(그게 있으면 아래
    // 슬라이드 테스트의 경로로 빠지므로, 이 테스트는 그 출구를 일부러 막아 둔다).
    const low = placeExtremeLabel(
      'below', 440, 120, w(LOW_TEXT), 760, 180,
      [{ top: 60, bottom: 172, left: 0, right: 760 }],
    );
    expect(low.y).toBe(174);
    expect(low.x).toBe(440);
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

  it('slides sideways past a partial-width legend and returns to the edge anchor', () => {
    // 레전드가 pane 좌측 절반만 덮고(right 400) 캔들은 위쪽(dot y=60)이라, 세로로는
    // 답이 없다: push 는 58 로 밀지만 캔들 상한이 42 로 되감고 그 박스는 여전히 레전드
    // 안이다. 가로로 rect 바깥(≈466)으로 비키면 가장자리(6)로 되돌아가 둘 다 피한다.
    const legend: AvoidRect = { top: 0, bottom: 56, left: 0, right: 400 };
    const high = placeExtremeLabel('above', 200, 60, w(HIGH_TEXT), 760, 180, [legend]);

    expect(high.y).toBe(6);
    expect(high.x).toBeGreaterThan(400);
    expect(overlaps2d({ ...high, place: 'above' }, HIGH_TEXT, legend)).toBe(false);
    // 캔들도 여전히 안전하다 — 가장자리 박스 {6,22} 는 dot(60) 위다.
    expect(highLabelBox(high.y).bottom).toBeLessThanOrEqual(60 - 2);
  });

  it('slides the low label sideways past a partial-width rect (mirror of the high case)', () => {
    const wall: AvoidRect = { top: 124, bottom: 180, left: 0, right: 400 };
    const low = placeExtremeLabel('below', 200, 120, w(LOW_TEXT), 760, 180, [wall]);

    expect(low.y).toBe(174);
    expect(low.x).toBeGreaterThan(400);
    expect(overlaps2d({ ...low, place: 'below' }, LOW_TEXT, wall)).toBe(false);
    expect(lowLabelBox(low.y).top).toBeGreaterThanOrEqual(120 + 2);
  });

  it('gives up sliding when the only clear x is past the slide cap', () => {
    // pane 360 → 상한 180px. rect 우측 바깥(≈266)은 **정말로 비어 있고 pane 안에도
    // 들어가지만** 좌측 끝(70.4)에서 196px 이라 상한을 넘는다 → 슬라이드 포기, 캔들
    // 상한 위치(42)에서 레전드와의 겹침을 감수한다. 이 방벽이 없으면 라벨이 화면
    // 반대편으로 날아가고 리더선이 pane 을 통째로 가로지른다.
    // ⚠ 픽스처 주의: 우측 후보가 rect 를 **실제로 벗어나야** 이 테스트가 상한을 잰다.
    // 자리 자체가 없으면 상한을 무력화해도 통과해 버린다(첫 판은 그래서 초록이었다).
    const legend: AvoidRect = { top: 0, bottom: 56, left: 0, right: 200 };
    const high = placeExtremeLabel('above', 70, 60, w(HIGH_TEXT), 360, 180, [legend]);

    expect(high.x).toBeLessThan(100);
    expect(high.y).toBe(42);
  });

  it('gives up sliding when the candle leaves no room even at the edge', () => {
    // dot 이 y=15 라 가장자리 박스 {6,22} 조차 캔들 상한(13)을 못 지킨다 — 어느 x 로
    // 가도 소용없으므로 슬라이드를 시도하지 않고 제자리(200)에 남는다.
    const legend: AvoidRect = { top: 0, bottom: 56, left: 0, right: 400 };
    const high = placeExtremeLabel('above', 200, 15, w(HIGH_TEXT), 760, 180, [legend]);

    expect(high.x).toBe(200);
    expect(high.y).toBe(6);
  });

  it('falls back to the original point before pane size is known', () => {
    expect(placeExtremeLabel('above', 20, 12, w('59,300원 (-3.90%)'), 0, 0)).toEqual({
      place: 'above',
      x: 20,
      y: 12,
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  snapAxis,
  computeMove,
  detectFollowers,
  computeResize,
  snapZone,
  zoneRect,
  SNAP_THRESHOLD,
  MIN_W,
  MIN_H,
  type RectWin,
  type Rect,
} from './snapEngine';

const CANVAS = { w: 1000, h: 800 };

describe('snapAxis', () => {
  it('임계 내 후보로 흡착한다', () => {
    const r = snapAxis(105, [{ val: 100, guide: 100, rank: 0 }], false);
    expect(r.val).toBe(100);
    expect(r.guide).toBe(100);
  });

  it('임계 밖이면 흡착하지 않는다(guide null)', () => {
    const r = snapAxis(100 + SNAP_THRESHOLD + 1, [{ val: 100, guide: 100, rank: 0 }], false);
    expect(r.val).toBe(100 + SNAP_THRESHOLD + 1);
    expect(r.guide).toBeNull();
  });

  it('임계 경계값(정확히 THRESHOLD)은 흡착한다', () => {
    const r = snapAxis(100 + SNAP_THRESHOLD, [{ val: 100, guide: 100, rank: 0 }], false);
    expect(r.val).toBe(100);
  });

  it('alt=true 면 흡착을 해제한다', () => {
    const r = snapAxis(103, [{ val: 100, guide: 100, rank: 0 }], true);
    expect(r.val).toBe(103);
    expect(r.guide).toBeNull();
  });

  it('최근접 후보를 택한다', () => {
    const r = snapAxis(108, [
      { val: 100, guide: 100, rank: 0 },
      { val: 110, guide: 110, rank: 0 },
    ], false);
    expect(r.val).toBe(110);
  });

  it('거리가 같으면 우선순위(rank)가 낮은 후보를 택한다 — 인접 > 정렬', () => {
    const r = snapAxis(105, [
      { val: 100, guide: 100, rank: 1 }, // 정렬
      { val: 110, guide: 110, rank: 0 }, // 인접 (같은 거리 5)
    ], false);
    expect(r.val).toBe(110);
  });
});

describe('computeMove', () => {
  it('이웃 오른변에 왼변을 인접 흡착한다', () => {
    const others: RectWin[] = [{ id: 'o', rect: { x: 100, y: 0, w: 200, h: 200 } }];
    // 내 왼변이 이웃 오른변(300) 근처 → x=300
    const r = computeMove({
      origin: { x: 305, y: 400, w: 150, h: 150 },
      dx: 0,
      dy: 0,
      others,
      canvas: CANVAS,
      alt: false,
    });
    expect(r.x).toBe(300);
    expect(r.guides.v).toBe(300);
  });

  it('화면 안으로 클램프한다(음수·초과 방지)', () => {
    const r = computeMove({
      origin: { x: 0, y: 0, w: 200, h: 150 },
      dx: -500,
      dy: 5000,
      others: [],
      canvas: CANVAS,
      alt: false,
    });
    expect(r.x).toBe(0);
    expect(r.y).toBe(CANVAS.h - 150);
  });

  it('alt=true 면 흡착 없이 이동한다', () => {
    const others: RectWin[] = [{ id: 'o', rect: { x: 100, y: 0, w: 200, h: 200 } }];
    const r = computeMove({
      origin: { x: 305, y: 400, w: 150, h: 150 },
      dx: 0,
      dy: 0,
      others,
      canvas: CANVAS,
      alt: true,
    });
    expect(r.x).toBe(305);
    expect(r.guides.v).toBeNull();
  });
});

describe('detectFollowers', () => {
  const dragged: Rect = { x: 100, y: 100, w: 200, h: 200 }; // 오른변 x=300, 아랫변 y=300

  it('오른변(e)에 맞닿고 겹치는 이웃을 잡는다', () => {
    const others: RectWin[] = [
      { id: 'east', rect: { x: 300, y: 120, w: 150, h: 100 } }, // 맞닿음 + 겹침
      { id: 'far', rect: { x: 320, y: 120, w: 150, h: 100 } }, // 20px 떨어짐
      { id: 'noOverlap', rect: { x: 300, y: 500, w: 150, h: 100 } }, // 맞닿았지만 세로 안 겹침
    ];
    expect(detectFollowers(dragged, 'e', others)).toEqual(['east']);
  });

  it('아랫변(s)에 맞닿는 이웃을 잡는다', () => {
    const others: RectWin[] = [{ id: 'south', rect: { x: 120, y: 300, w: 100, h: 150 } }];
    expect(detectFollowers(dragged, 's', others)).toEqual(['south']);
  });

  it('맞닿지 않으면 빈 배열', () => {
    const others: RectWin[] = [{ id: 'gap', rect: { x: 310, y: 120, w: 100, h: 100 } }];
    expect(detectFollowers(dragged, 'e', others)).toEqual([]);
  });
});

describe('computeResize — 순수 변 스플리터 승격', () => {
  const origin: Rect = { x: 100, y: 100, w: 200, h: 200 }; // 오른변 x=300
  // 여유 있는 이웃(폭 400, 오른변 700) — +60 드래그가 MIN_W 클램프에 안 걸린다.
  const roomy: RectWin = { id: 'east', rect: { x: 300, y: 100, w: 400, h: 200 } };
  // 빠듯한 이웃(폭 200, 오른변 500) — MIN_W 클램프 검증용.
  const tight: RectWin = { id: 'east', rect: { x: 300, y: 100, w: 200, h: 200 } };

  it('오른변을 늘리면 동쪽 이웃이 함께 줄어든다', () => {
    const r = computeResize({
      origin,
      mode: 'e',
      dx: 60,
      dy: 0,
      others: [roomy],
      followers: [roomy],
      canvas: CANVAS,
      alt: true, // 흡착 배제하고 스플리터 산술만 검증
    });
    expect(r.rect.w).toBe(260); // 200 + 60
    expect(r.followers).toHaveLength(1);
    expect(r.followers[0].rect.x).toBe(360); // 이웃 왼변이 새 경계로
    expect(r.followers[0].rect.w).toBe(340); // 700 - 360
  });

  it('follower 가 MIN_W 에 닿으면 드래그 변도 함께 멈춘다(#714)', () => {
    // 빠듯한 이웃(폭200)을 MIN_W 이하로 밀 만큼 크게 드래그 → 이웃은 MIN_W, 경계는 500-MIN_W 에서 정지
    const r = computeResize({
      origin,
      mode: 'e',
      dx: 1000,
      dy: 0,
      others: [tight],
      followers: [tight],
      canvas: CANVAS,
      alt: true,
    });
    const boundary = 500 - MIN_W; // follower.x0 + follower.w0 - MIN_W
    expect(r.rect.w).toBe(boundary - origin.x);
    expect(r.followers[0].rect.x).toBe(boundary);
    expect(r.followers[0].rect.w).toBe(MIN_W);
  });

  it('모서리(2변) 드래그는 스플리터 승격이 없다', () => {
    const r = computeResize({
      origin,
      mode: 'se',
      dx: 60,
      dy: 60,
      others: [roomy],
      followers: [roomy],
      canvas: CANVAS,
      alt: true,
    });
    expect(r.followers).toHaveLength(0);
    expect(r.rect.w).toBe(260);
    expect(r.rect.h).toBe(260);
  });

  it('왼변 리사이즈는 x·w 를 함께 조정하고 MIN_W 아래로 안 내려간다', () => {
    const r = computeResize({
      origin,
      mode: 'w',
      dx: 1000, // 오른쪽으로 과하게 → 폭이 MIN_W 에서 멈춤
      dy: 0,
      others: [],
      followers: [],
      canvas: CANVAS,
      alt: true,
    });
    expect(r.rect.w).toBe(MIN_W);
    expect(r.rect.x).toBe(origin.x + origin.w - MIN_W); // 오른변은 고정(300)
  });

  it('아랫변 리사이즈는 MIN_H 아래로 안 내려간다', () => {
    const r = computeResize({
      origin,
      mode: 's',
      dx: 0,
      dy: -1000,
      others: [],
      followers: [],
      canvas: CANVAS,
      alt: true,
    });
    expect(r.rect.h).toBe(MIN_H);
  });

  it('흡착이 MIN 경계를 넘겨 당겨도 hard MIN 을 지킨다(흡착은 무시)', () => {
    // origin.x=100 → MIN 경계 x=260. 이웃 오른변을 255(경계 안쪽 5px)에 두면
    // snapAxis 는 255 로 당기려 하지만, 클램프가 260 으로 되박고 가이드를 숨긴다.
    const inside: RectWin = { id: 'edge', rect: { x: 55, y: 100, w: 200, h: 40 } }; // 오른변 255
    const r = computeResize({
      origin, // x=100, w=200
      mode: 'e',
      dx: -1000, // 최소로 줄이려는 드래그
      dy: 0,
      others: [inside],
      followers: [],
      canvas: CANVAS,
      alt: false, // 흡착 켜짐
    });
    expect(r.rect.w).toBe(MIN_W); // 148~159 로 undershoot 되지 않음
    expect(r.guides.v).toBeNull(); // 흡착 목표에 도달 못 했으므로 가이드 숨김
  });
});

describe('snapZone / zoneRect', () => {
  it('좌측 벽 근처면 left', () => {
    expect(snapZone(10, CANVAS, false)).toBe('left');
  });
  it('우측 벽 근처면 right', () => {
    expect(snapZone(CANVAS.w - 10, CANVAS, false)).toBe('right');
  });
  it('가운데면 null', () => {
    expect(snapZone(500, CANVAS, false)).toBeNull();
  });
  it('alt=true 면 스냅존 비활성', () => {
    expect(snapZone(10, CANVAS, true)).toBeNull();
  });
  it('zoneRect 는 좌/우 절반을 만든다', () => {
    expect(zoneRect('left', CANVAS)).toEqual({ x: 0, y: 0, w: 500, h: 800 });
    expect(zoneRect('right', CANVAS)).toEqual({ x: 500, y: 0, w: 500, h: 800 });
  });
});

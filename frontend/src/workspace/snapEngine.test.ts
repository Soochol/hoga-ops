import { describe, expect, it } from 'vitest';
import {
  snapAxis,
  computeMove,
  detectFollowers,
  computeResize,
  SNAP_THRESHOLD,
  MIN_W,
  MIN_H,
  GRAB_EXPOSE_W,
  GRAB_EXPOSE_H,
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

  it('좌·우·아래로는 화면 밖으로 나가되 헤더 손잡이를 남긴다 (ADR-0127)', () => {
    const origin: Rect = { x: 0, y: 0, w: 200, h: 150 };
    const args = { origin, others: [], canvas: CANVAS, alt: true };

    const left = computeMove({ ...args, dx: -5000, dy: 0 });
    expect(left.x).toBe(GRAB_EXPOSE_W - origin.w); // 오른쪽 끝 48px 만 남는다
    expect(left.x + origin.w).toBe(GRAB_EXPOSE_W);

    const right = computeMove({ ...args, dx: 5000, dy: 0 });
    expect(right.x).toBe(CANVAS.w - GRAB_EXPOSE_W); // 왼쪽 끝 48px 만 남는다

    const down = computeMove({ ...args, dx: 0, dy: 5000 });
    expect(down.y).toBe(CANVAS.h - GRAB_EXPOSE_H); // 헤더 높이만 남는다
  });

  it('위로는 나가지 못한다 — 헤더가 사라지면 다시 잡을 수 없다', () => {
    const r = computeMove({
      origin: { x: 300, y: 400, w: 200, h: 150 },
      dx: 0,
      dy: -5000,
      others: [],
      canvas: CANVAS,
      alt: true,
    });
    expect(r.y).toBe(0);
  });

  it('화면 경계 흡착은 이탈 경로에서도 살아 있다', () => {
    // 오른쪽 벽에 딱 맞는 위치(x=800) 근처를 지나면 여전히 흡착한다 — 이탈은
    // 흡착 임계(12px)를 넘겨 계속 밀 때만 일어난다.
    const r = computeMove({
      origin: { x: 795, y: 100, w: 200, h: 150 },
      dx: 0,
      dy: 0,
      others: [],
      canvas: CANVAS,
      alt: false,
    });
    expect(r.x).toBe(CANVAS.w - 200);
    expect(r.guides.v).toBe(CANVAS.w);
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

  it('Y축: 이웃 아랫변에 윗변을 인접 흡착한다(guides.h)', () => {
    // x=400 은 이웃 후보에서 먼 곳 → X축 흡착 없음, Y축만 검증
    const others: RectWin[] = [{ id: 'o', rect: { x: 0, y: 0, w: 200, h: 300 } }]; // 아랫변 y=300
    const r = computeMove({
      origin: { x: 400, y: 305, w: 150, h: 150 },
      dx: 0,
      dy: 0,
      others,
      canvas: CANVAS,
      alt: false,
    });
    expect(r.y).toBe(300);
    expect(r.guides.h).toBe(300);
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

  it('왼변(w)에 맞닿는 이웃(오른변이 dragged 왼변에 닿음)을 잡는다', () => {
    const others: RectWin[] = [
      { id: 'west', rect: { x: 0, y: 120, w: 100, h: 100 } }, // 오른변 x=100 = dragged 왼변
      { id: 'noOverlap', rect: { x: 0, y: 500, w: 100, h: 40 } }, // 맞닿지만 세로 안 겹침
    ];
    expect(detectFollowers(dragged, 'w', others)).toEqual(['west']);
  });

  it('윗변(n)에 맞닿는 이웃(아랫변이 dragged 윗변에 닿음)을 잡는다', () => {
    const others: RectWin[] = [{ id: 'north', rect: { x: 120, y: 0, w: 100, h: 100 } }]; // 아랫변 y=100 = dragged 윗변
    expect(detectFollowers(dragged, 'n', others)).toEqual(['north']);
  });

  it('맞닿지 않으면 빈 배열', () => {
    const others: RectWin[] = [{ id: 'gap', rect: { x: 310, y: 120, w: 100, h: 100 } }];
    expect(detectFollowers(dragged, 'e', others)).toEqual([]);
  });
});

describe('computeResize — w/s/n 스플리터 승격 대칭', () => {
  it('왼변(w) 드래그: 서쪽 이웃 오른변이 함께 이동', () => {
    const origin: Rect = { x: 300, y: 100, w: 200, h: 200 }; // 왼변 x=300
    const west: RectWin = { id: 'west', rect: { x: 0, y: 100, w: 300, h: 200 } }; // 오른변 x=300
    const r = computeResize({
      origin,
      mode: 'w',
      dx: -60, // 왼변을 왼쪽으로 → origin 넓어지고 west 줄어듦
      dy: 0,
      others: [west],
      followers: [west],
      canvas: CANVAS,
      alt: true,
    });
    expect(r.rect.x).toBe(240);
    expect(r.rect.w).toBe(260); // 500 - 240
    expect(r.followers[0].rect.x).toBe(0);
    expect(r.followers[0].rect.w).toBe(240); // 새 경계(240) - 0
  });

  it('아랫변(s) 드래그: 남쪽 이웃 윗변이 함께 이동', () => {
    const origin: Rect = { x: 100, y: 100, w: 200, h: 200 }; // 아랫변 y=300
    const south: RectWin = { id: 'south', rect: { x: 100, y: 300, w: 200, h: 300 } }; // 윗변 y=300
    const r = computeResize({
      origin,
      mode: 's',
      dx: 0,
      dy: 60,
      others: [south],
      followers: [south],
      canvas: CANVAS,
      alt: true,
    });
    expect(r.rect.h).toBe(260);
    expect(r.followers[0].rect.y).toBe(360);
    expect(r.followers[0].rect.h).toBe(240); // 600 - 360
  });

  it('윗변(n) 드래그: 북쪽 이웃 아랫변이 함께 이동', () => {
    const origin: Rect = { x: 100, y: 300, w: 200, h: 200 }; // 윗변 y=300
    const north: RectWin = { id: 'north', rect: { x: 100, y: 0, w: 200, h: 300 } }; // 아랫변 y=300
    const r = computeResize({
      origin,
      mode: 'n',
      dx: 0,
      dy: -60,
      others: [north],
      followers: [north],
      canvas: CANVAS,
      alt: true,
    });
    expect(r.rect.y).toBe(240);
    expect(r.rect.h).toBe(260);
    expect(r.followers[0].rect.h).toBe(240); // 새 경계(240) - 0
  });

  it('윗변(n) 단독 리사이즈는 MIN_H 아래로 안 내려간다', () => {
    const origin: Rect = { x: 100, y: 300, w: 200, h: 200 };
    const r = computeResize({
      origin,
      mode: 'n',
      dx: 0,
      dy: 1000, // 윗변을 아래로 과하게 → 높이 MIN_H 에서 멈춤
      others: [],
      followers: [],
      canvas: CANVAS,
      alt: true,
    });
    expect(r.rect.h).toBe(MIN_H);
    expect(r.rect.y).toBe(origin.y + origin.h - MIN_H); // 아랫변 고정(500)
  });

  it('sub-MIN follower 는 드래그 창을 MIN 아래로 밀지 못한다(드래그 MIN 우선)', () => {
    const origin: Rect = { x: 100, y: 100, w: 200, h: 200 }; // 오른변 300
    const tiny: RectWin = { id: 'east', rect: { x: 300, y: 100, w: 100, h: 200 } }; // 폭 100 < MIN_W
    const r = computeResize({
      origin,
      mode: 'e',
      dx: -1000, // origin 을 최소로 줄이려 함
      dy: 0,
      others: [tiny],
      followers: [tiny],
      canvas: CANVAS,
      alt: true,
    });
    expect(r.rect.w).toBe(MIN_W); // 밴드 역전 가드로 드래그 창은 MIN 유지
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

describe('computeResize — 화면 밖에 걸친 창 (ADR-0127)', () => {
  it('밖으로 나간 변을 잡아도 화면 안으로 되당기지 않는다(점프 방지)', () => {
    // 오른쪽으로 200px 걸쳐 나간 창. 예전 클램프(hi=canvas.w)면 오른변이 1000 으로
    // 튀면서 손도 안 댄 폭이 확 줄어든다.
    const origin: Rect = { x: 900, y: 100, w: 300, h: 200 }; // 오른변 1200 > canvas.w
    const r = computeResize({
      origin, mode: 'e', dx: 0, dy: 0,
      others: [], followers: [], canvas: CANVAS, alt: true,
    });
    expect(r.rect.w).toBe(300);

    const below: Rect = { x: 100, y: 700, w: 200, h: 300 }; // 아랫변 1000 > canvas.h
    const s = computeResize({
      origin: below, mode: 's', dx: 0, dy: 0,
      others: [], followers: [], canvas: CANVAS, alt: true,
    });
    expect(s.rect.h).toBe(300);

    const outLeft: Rect = { x: -150, y: 100, w: 300, h: 200 }; // 왼변 -150 < 0
    const w = computeResize({
      origin: outLeft, mode: 'w', dx: 0, dy: 0,
      others: [], followers: [], canvas: CANVAS, alt: true,
    });
    expect(w.rect.x).toBe(-150);
    expect(w.rect.w).toBe(300);
  });

  it('밖에 걸친 변을 안으로 줄이는 것은 열려 있다', () => {
    const origin: Rect = { x: 900, y: 100, w: 300, h: 200 };
    const r = computeResize({
      origin, mode: 'e', dx: -250, dy: 0,
      others: [], followers: [], canvas: CANVAS, alt: true,
    });
    expect(r.rect.w).toBe(MIN_W); // 300-250=50 → MIN_W 에서 정지
  });

  it('화면 안 창은 리사이즈로 밖까지 늘어나지 않는다(이동만 이탈 허용)', () => {
    const origin: Rect = { x: 700, y: 100, w: 200, h: 200 }; // 오른변 900, 화면 안
    const r = computeResize({
      origin, mode: 'e', dx: 5000, dy: 0,
      others: [], followers: [], canvas: CANVAS, alt: true,
    });
    expect(r.rect.x + r.rect.w).toBe(CANVAS.w);
  });
});

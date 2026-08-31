// frontend/src/chart/drawing/hitTest.test.ts
import { describe, expect, it } from 'vitest';
import {
  distanceToHline,
  distanceToSegment,
  distanceToPolyline,
  drawingsInRect,
  hitTestDrawings,
  marqueeRect,
  unlockedOnly,
  type HitCoord,
} from './hitTest';
import type { Drawing } from './types';

describe('distanceToHline', () => {
  it('returns vertical distance from the cursor Y to the line Y', () => {
    expect(distanceToHline({ x: 100, y: 50 }, 60)).toBe(10);
    expect(distanceToHline({ x: -999, y: 200 }, 200)).toBe(0);
  });
});

describe('distanceToSegment', () => {
  it('returns 0 when the point lies on the segment', () => {
    expect(distanceToSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
  });

  it('returns perpendicular distance for a point above a horizontal segment', () => {
    expect(distanceToSegment({ x: 5, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(4);
  });

  it('returns distance to nearest endpoint when projection falls outside', () => {
    expect(distanceToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('handles degenerate segments (a == b) as point distance', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('distanceToPolyline', () => {
  it('returns the minimum distance across all consecutive segments', () => {
    const polyline = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(distanceToPolyline({ x: 5, y: 3 }, polyline)).toBe(3);
    expect(distanceToPolyline({ x: 13, y: 5 }, polyline)).toBe(3);
  });

  it('returns Infinity for polylines with fewer than 2 points', () => {
    expect(distanceToPolyline({ x: 0, y: 0 }, [])).toBe(Infinity);
    expect(distanceToPolyline({ x: 0, y: 0 }, [{ x: 1, y: 1 }])).toBe(Infinity);
  });
});

/** SR-5: hitTestDrawings is the kind-dispatch interaction core lifted out of
 * DrawingOverlay so it can be tested with stub coordinate closures instead of
 * a live IChartApi. These cases pin pane-match gating, per-kind threshold
 * compares, and topmost-first ordering. */
describe('hitTestDrawings', () => {
  // Identity-ish stub coords: x == realMs, y == price; everything is on
  // 'candle'. Lets each case place geometry in plain pixel space.
  const coord: HitCoord = {
    realMsToCanvasX: (realMs) => realMs,
    priceToCanvasY: (price) => price,
    paneIdAtY: () => 'candle',
  };

  const hline = (id: string, price: number): Drawing => ({
    id, kind: 'hline', price, paneId: 'candle',
    color: '#fff', width: 2, lineStyle: 'solid',
  });

  it('hits an hline within the hline threshold (6px) and misses beyond it', () => {
    const d = hline('h1', 100);
    expect(hitTestDrawings(coord, [d], 50, 104)).toBe(d); // 4px away → hit
    expect(hitTestDrawings(coord, [d], 50, 110)).toBeNull(); // 10px away → miss
  });

  it('returns null when the cursor pane does not match the drawing pane', () => {
    const d = hline('h1', 100);
    const otherPane: HitCoord = { ...coord, paneIdAtY: () => 'volume' };
    expect(hitTestDrawings(otherPane, [d], 50, 100)).toBeNull();
  });

  it('hits a trendline body within trendlineBody threshold (8px)', () => {
    const t: Drawing = {
      id: 't1', kind: 'trendline', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid',
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 0 },
    };
    expect(hitTestDrawings(coord, [t], 50, 5)).toBe(t); // 5px above the segment
    expect(hitTestDrawings(coord, [t], 50, 20)).toBeNull(); // 20px → miss
  });

  it('hits a pencil polyline within pencil threshold (8px)', () => {
    const p: Drawing = {
      id: 'p1', kind: 'pencil', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid',
      points: [
        { realMs: 0, price: 0 },
        { realMs: 100, price: 0 },
        { realMs: 100, price: 100 },
      ],
    };
    expect(hitTestDrawings(coord, [p], 50, 3)).toBe(p);
    expect(hitTestDrawings(coord, [p], 50, 30)).toBeNull();
  });

  it('연필의 subX 를 히트 기하에도 반영한다', () => {
    // 렌더가 미는 만큼 히트 박스도 밀려야 한다. 안 그러면 스트로크가
    // 그려진 자리에서 안 잡히고 옛 봉 자리에서 잡힌다.
    const p: Drawing = {
      id: 'p1', kind: 'pencil', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid',
      points: [
        { realMs: 0, price: 0 },
        { realMs: 100, price: 0 },
      ],
      subX: [2, 2], // 봉 폭 20px × 2 = +40px
    };
    const withPitch: HitCoord = { ...coord, barPx: 20 };
    // 40px 밀린 선분은 x∈[40,140] 에 있다. 왼쪽 끝 밖(x=10)은 빗나가고,
    // 오른쪽으로 밀린 자리(x=130)는 맞는다.
    expect(hitTestDrawings(withPitch, [p], 10, 0)).toBeNull();
    expect(hitTestDrawings(withPitch, [p], 130, 0)).toBe(p);
  });

  it('barPx 가 없으면 연필 오프셋을 무시한다 — 봉 앵커 기하', () => {
    const p: Drawing = {
      id: 'p1', kind: 'pencil', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid',
      points: [
        { realMs: 0, price: 0 },
        { realMs: 100, price: 0 },
      ],
      subX: [2, 2],
    };
    // 같은 stroke, pitch 없음 → x∈[0,100] 그대로.
    expect(hitTestDrawings(coord, [p], 10, 0)).toBe(p);
    expect(hitTestDrawings(coord, [p], 130, 0)).toBeNull();
  });

  it('returns the topmost (last-drawn) drawing when two overlap', () => {
    const bottom = hline('bottom', 100);
    const top = hline('top', 100);
    // Array order = z-order; iteration is back-to-front so the LAST element wins.
    expect(hitTestDrawings(coord, [bottom, top], 50, 100)).toBe(top);
  });

  it('hits a vline by horizontal proximity regardless of cursor pane', () => {
    const v: Drawing = {
      id: 'v1', kind: 'vline', realMs: 100, paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid',
    };
    // Cursor in a DIFFERENT pane (volume) still grabs the vline (pane-agnostic).
    const otherPane: HitCoord = { ...coord, paneIdAtY: () => 'volume' };
    expect(hitTestDrawings(otherPane, [v], 104, 999)).toBe(v); // 4px away → hit
    expect(hitTestDrawings(otherPane, [v], 110, 999)).toBeNull(); // 10px → miss
  });

  it('hits a rect on its border AND its interior (solid box, grab-to-move)', () => {
    const r: Drawing = {
      id: 'r1', kind: 'rect', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid', fillOpacity: 0.2,
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 100 },
    };
    const c: HitCoord = { ...coord, canvasWidth: 800 };
    expect(hitTestDrawings(c, [r], 3, 50)).toBe(r); // near left edge → hit
    expect(hitTestDrawings(c, [r], 50, 3)).toBe(r); // near top edge → hit
    expect(hitTestDrawings(c, [r], 50, 50)).toBe(r); // dead centre → hit (fill)
    expect(hitTestDrawings(c, [r], 200, 50)).toBeNull(); // outside the box → miss
  });

  it('rect with a corner off-axis falls back to the canvas edge and stays selectable', () => {
    const r: Drawing = {
      id: 'r1', kind: 'rect', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid', fillOpacity: 0,
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 100 },
    };
    // b.realMs projects off-axis → x falls back to canvasWidth (800).
    const c: HitCoord = {
      ...coord,
      canvasWidth: 800,
      realMsToCanvasX: (realMs) => (realMs === 100 ? null : realMs),
    };
    expect(hitTestDrawings(c, [r], 3, 50)).toBe(r); // left edge still resolves
  });

  // ── 우측 확장 ────────────────────────────────────────────────────────────
  //
  // 렌더 쪽 짝은 render.test.ts 의 "사각형 우측 확장 — 렌더" 다. 두 파일이 같은
  // `rectXSpan` 을 서로 다른 입구에서 재는 것이 요점이다 — 한쪽만 확장을 알면
  // 사각형이 그려진 자리에서 안 잡히거나, 안 보이는 곳에서 잡힌다.
  it('확장된 사각형은 오른쪽 밴드 안에서도 잡힌다', () => {
    const r: Drawing = {
      id: 'r1', kind: 'rect', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid', fillOpacity: 0.2,
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 100 },
      extendRight: true,
    };
    const c: HitCoord = { ...coord, canvasWidth: 800, plotWidth: 800 };
    expect(hitTestDrawings(c, [r], 400, 50)).toBe(r); // 그린 폭 밖, 확장 밴드 안
    expect(hitTestDrawings(c, [r], 799, 50)).toBe(r); // 확장 끝
    expect(hitTestDrawings(c, [r], 400, 150)).toBeNull(); // 세로는 확장 안 된다
  });

  it('확장이 꺼진 같은 사각형은 그 밴드에서 안 잡힌다 — 판정이 플래그에 달렸음을 고정', () => {
    const r: Drawing = {
      id: 'r1', kind: 'rect', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid', fillOpacity: 0.2,
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 100 },
    };
    const c: HitCoord = { ...coord, canvasWidth: 800, plotWidth: 800 };
    expect(hitTestDrawings(c, [r], 400, 50)).toBeNull();
  });

  it('확장 폭은 컨테이너가 아니라 **플롯** 폭을 쓴다 — 가격축 거터는 사각형 밖이다', () => {
    const r: Drawing = {
      id: 'r1', kind: 'rect', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid', fillOpacity: 0.2,
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 100 },
      extendRight: true,
    };
    // 컨테이너(inset-0)는 거터까지 덮어 860, 렌더가 도는 플롯은 800.
    const c: HitCoord = { ...coord, canvasWidth: 860, plotWidth: 800 };
    expect(hitTestDrawings(c, [r], 799, 50)).toBe(r);
    // 거터 위(820)에서 잡히면 그 자리의 축 드래그가 죽는다.
    expect(hitTestDrawings(c, [r], 820, 50)).toBeNull();
  });

  it('마퀴도 확장된 폭을 본다 — 화면에 보이는 띠를 둘러쌌으면 잡혀야 한다', () => {
    const r: Drawing = {
      id: 'r1', kind: 'rect', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid', fillOpacity: 0.2,
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 100 },
      extendRight: true,
    };
    const c: HitCoord = { ...coord, canvasWidth: 800, plotWidth: 800 };
    const band = marqueeRect(300, 40, 500, 60); // 그린 폭 밖, 확장 밴드 안
    expect(drawingsInRect(c, [r], band)).toEqual([r]);
    expect(drawingsInRect(c, [{ ...r, extendRight: undefined }], band)).toEqual([]);
  });

  it('hits a text label within its measured bounding box', () => {
    const t: Drawing = {
      id: 't1', kind: 'text', at: { realMs: 100, price: 100 },
      text: '메모', fontSize: 13, paneId: 'candle',
      color: '#fff', width: 1, lineStyle: 'solid',
    };
    // Stub measureTextWidth → 40px box; anchor at (100,100), height ≈ 13+4.
    const c: HitCoord = { ...coord, measureTextWidth: () => 40 };
    expect(hitTestDrawings(c, [t], 110, 105)).toBe(t); // inside the box
    expect(hitTestDrawings(c, [t], 200, 105)).toBeNull(); // right of the box
    expect(hitTestDrawings(c, [t], 110, 130)).toBeNull(); // below the box
  });

  it('keeps an off-axis text grabbable via the clamped projector (dragged into a gap)', () => {
    const t: Drawing = {
      id: 't1', kind: 'text', at: { realMs: 50_000, price: 100 },
      text: '메모', fontSize: 13, paneId: 'candle',
      color: '#fff', width: 1, lineStyle: 'solid',
    };
    // Plain projector returns null for this gap anchor (would vanish +
    // un-selectable); the clamped projector snaps it to x=120 so it stays
    // grabbable there — exactly how renderText paints it.
    const c: HitCoord = {
      ...coord,
      measureTextWidth: () => 40,
      realMsToCanvasX: (realMs) => (realMs === 50_000 ? null : realMs),
      realMsToCanvasXClamped: (realMs) => (realMs === 50_000 ? 120 : realMs),
    };
    // Without the clamp the text is unreachable:
    const noClamp: HitCoord = { ...c, realMsToCanvasXClamped: undefined };
    expect(hitTestDrawings(noClamp, [t], 130, 105)).toBeNull();
    // With the clamp, the box sits at x∈[117,163] → (130,105) hits.
    expect(hitTestDrawings(c, [t], 130, 105)).toBe(t);
  });

  it('returns null for an empty drawing list', () => {
    expect(hitTestDrawings(coord, [], 50, 100)).toBeNull();
  });

  it('skips a drawing whose projected coordinates are null (off-axis)', () => {
    const offAxis: HitCoord = { ...coord, priceToCanvasY: () => null };
    expect(hitTestDrawings(offAxis, [hline('h1', 100)], 50, 100)).toBeNull();
  });
});

// ── 잠금 게이트 (ADR-0164) ─────────────────────────────────────────────────
describe('unlockedOnly — 포인터 게이트가 보는 부분집합', () => {
  const coord: HitCoord = {
    realMsToCanvasX: (realMs) => realMs,
    priceToCanvasY: (price) => price,
    paneIdAtY: () => 'candle',
  };
  const hline = (id: string, price: number, locked?: boolean): Drawing => ({
    id, kind: 'hline', price, paneId: 'candle',
    color: '#fff', width: 2, lineStyle: 'solid',
    ...(locked ? { locked: true } : {}),
  });

  it('잠긴 것을 빼고 나머지는 순서까지 그대로 남긴다', () => {
    const a = hline('a', 10);
    const locked = hline('b', 20, true);
    const c = hline('c', 30);
    expect(unlockedOnly([a, locked, c])).toEqual([a, c]);
  });

  it('전부 잠겼으면 빈 배열 — 게이트는 pointerEvents 를 none 으로 둔다', () => {
    expect(unlockedOnly([hline('a', 10, true)])).toEqual([]);
  });

  // ⚠ 이 케이스가 "먼저 거르고 히트 판정" 순서의 존재 이유다. hitTestDrawings 는
  // **최상단** 매치를 돌려주므로, 히트부터 하고 결과의 locked 를 보면 위에 있는
  // 잠긴 도형이 아래 살아 있는 도형을 가려 버린다 — 그 도형이 조용히 안 잡히게 된다.
  it('겹쳐 있을 때 위의 잠긴 도형이 아래 잠기지 않은 도형을 가리지 않는다', () => {
    const live = hline('live', 100);
    const lockedOnTop = hline('locked', 100, true); // 같은 y, 나중에 그려져 위
    const stack = [live, lockedOnTop];

    // 히트부터 하면 최상단인 잠긴 것이 이긴다 — 이게 틀린 순서다.
    expect(hitTestDrawings(coord, stack, 50, 100)?.id).toBe('locked');
    // 먼저 거르면 아래 살아 있는 도형이 제대로 잡힌다.
    expect(hitTestDrawings(coord, unlockedOnly(stack), 50, 100)?.id).toBe('live');
  });
});

/** 마퀴(Shift+드래그) 커널. `hitTestDrawings` 와 같은 투영 bag 위에서 돌지만
 *  묻는 것이 다르다 — 점과의 거리가 아니라 **사각형과의 교차**다. */
describe('drawingsInRect', () => {
  const style = { color: '#14B8A6', width: 1.5, lineStyle: 'solid' as const };
  // 가격 100 → y 100 (1:1), 시각 ms → x 그대로. 스텁이 항등이라 기대값을 픽셀로
  // 직접 읽을 수 있다.
  const coord: HitCoord = {
    realMsToCanvasX: (ms) => ms,
    priceToCanvasY: (price) => price,
    paneIdAtY: () => 'candle',
    canvasWidth: 800,
    measureTextWidth: (text, sizePx) => text.length * sizePx * 0.6,
  };
  const box = { x1: 100, y1: 100, x2: 200, y2: 200 };

  const hline = (price: number, id = 'h'): Drawing =>
    ({ id, kind: 'hline', price, ...style, paneId: 'candle' }) as Drawing;
  const vline = (realMs: number, id = 'v'): Drawing =>
    ({ id, kind: 'vline', realMs, ...style, paneId: 'candle' }) as Drawing;
  const trend = (
    a: [number, number],
    b: [number, number],
    id = 't',
  ): Drawing =>
    ({
      id, kind: 'trendline',
      a: { realMs: a[0], price: a[1] }, b: { realMs: b[0], price: b[1] },
      ...style, paneId: 'candle',
    }) as Drawing;

  const ids = (list: Drawing[]) => drawingsInRect(coord, list, box).map((d) => d.id);

  // 포함(containment)이 아니라 교차인 이유가 이 두 케이스다. hline 은 캔버스
  // 전폭을, vline 은 전고를 차지하므로 어떤 박스에도 "들어갈" 수 없다 —
  // 포함 규칙이었다면 가장 흔한 두 도형을 마퀴가 영영 못 집는다.
  it('hline 은 y 만 본다 — 박스의 x 범위와 무관하게 잡힌다', () => {
    expect(ids([hline(150)])).toEqual(['h']);
    expect(ids([hline(99)])).toEqual([]);
    expect(ids([hline(201)])).toEqual([]);
  });

  it('vline 은 x 만 본다', () => {
    expect(ids([vline(150)])).toEqual(['v']);
    expect(ids([vline(99)])).toEqual([]);
  });

  it('추세선은 박스를 관통하기만 해도 잡힌다 — 양 끝이 밖이어도', () => {
    expect(ids([trend([0, 0], [300, 300])])).toEqual(['t']);
  });

  it('박스 안에 완전히 든 추세선도 잡힌다', () => {
    expect(ids([trend([120, 120], [180, 180])])).toEqual(['t']);
  });

  it('스치지 않는 추세선은 잡히지 않는다', () => {
    // 박스 왼쪽 위를 지나가는 평행선.
    expect(ids([trend([0, 0], [90, 90])])).toEqual([]);
  });

  it('사각형은 겹치기만 하면 잡힌다(모서리만 걸쳐도)', () => {
    const r: Drawing = {
      id: 'r', kind: 'rect',
      a: { realMs: 190, price: 190 }, b: { realMs: 400, price: 400 },
      ...style, fillOpacity: 0.1, paneId: 'candle',
    } as Drawing;
    expect(ids([r])).toEqual(['r']);
  });

  it('연필은 획의 한 구간만 걸쳐도 잡힌다', () => {
    const p: Drawing = {
      id: 'p', kind: 'pencil',
      points: [
        { realMs: 0, price: 0 },
        { realMs: 150, price: 150 },
        { realMs: 500, price: 500 },
      ],
      ...style, paneId: 'candle',
    } as Drawing;
    expect(ids([p])).toEqual(['p']);
  });

  it('점 하나짜리 연필 획도 박스 안이면 잡힌다', () => {
    const dot: Drawing = {
      id: 'dot', kind: 'pencil',
      points: [{ realMs: 150, price: 150 }],
      ...style, paneId: 'candle',
    } as Drawing;
    expect(ids([dot])).toEqual(['dot']);
  });

  it('텍스트는 그려지는 박스로 판정한다', () => {
    const t = (realMs: number, price: number, id: string): Drawing =>
      ({ id, kind: 'text', at: { realMs, price }, text: 'ab', fontSize: 10, ...style, paneId: 'candle' }) as Drawing;
    // (150,150) 에서 폭 12(=2글자×10×0.6), 높이 10 → 박스 안.
    expect(ids([t(150, 150, 'in')])).toEqual(['in']);
    // 앵커가 박스 오른쪽 밖이면 폭을 더해도 돌아오지 않는다.
    expect(ids([t(210, 150, 'out')])).toEqual([]);
  });

  it('여러 개를 목록(z) 순서 그대로 돌려준다', () => {
    expect(ids([hline(150, 'h1'), vline(150, 'v1'), hline(160, 'h2')])).toEqual(['h1', 'v1', 'h2']);
  });

  // 마퀴는 **잠긴 것도 담는다** — 지목과 편집은 다른 일이고, 잠긴 것을 여럿 담을
  // 수 있어야 한꺼번에 풀 수 있다. 이동·수정·삭제는 스토어가 계속 막는다(ADR-0164).
  it('잠긴 도형도 담는다 — 일괄 잠금 해제가 지나는 길', () => {
    const locked = { ...hline(150, 'lk'), locked: true } as Drawing;
    expect(ids([locked])).toEqual(['lk']);
  });

  // 반면 **점 히트 테스트**는 여전히 잠긴 것을 걸러 쓴다. 묻는 것이 다르기 때문이다
  // — "오버레이가 이 포인터를 삼킬 것인가, 차트가 팬할 것인가".
  it('점 히트 테스트의 unlockedOnly 합성은 그대로다', () => {
    const locked = { ...hline(150, 'lk'), locked: true } as Drawing;
    expect(unlockedOnly([locked])).toEqual([]);
  });
});

describe('marqueeRect', () => {
  it('어느 방향으로 끌어도 같은 사각형으로 정규화된다', () => {
    const expected = { x1: 10, y1: 20, x2: 50, y2: 80 };
    expect(marqueeRect(10, 20, 50, 80)).toEqual(expected);
    expect(marqueeRect(50, 80, 10, 20)).toEqual(expected);
    expect(marqueeRect(50, 20, 10, 80)).toEqual(expected);
  });
});

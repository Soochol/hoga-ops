import { describe, expect, it } from 'vitest';
import { isFracRect, toFrac, toPx } from './rectSpace';

describe('rectSpace — 비율↔px 좌표 변환 (ADR-0122)', () => {
  it('캔버스가 줄어도 창의 상대 배치가 보존된다', () => {
    const frac = { x: 0.5, y: 0.25, w: 0.4, h: 0.5 };

    const wide = toPx(frac, { w: 1546, h: 776 });
    const narrow = toPx(frac, { w: 972, h: 560 });

    // 절대 px 는 달라지지만 캔버스 대비 위치·크기 비율은 동일 — "배치는 유지, 크기만 반응형".
    expect(wide.x).toBeCloseTo(773, 6);
    expect(wide.w).toBeCloseTo(618.4, 6);
    expect(narrow.x / 972).toBeCloseTo(wide.x / 1546, 10);
    expect(narrow.w / 972).toBeCloseTo(wide.w / 1546, 10);
  });

  it('왕복(px→비율→px)이 같은 캔버스에서 무손실이다', () => {
    const canvas = { w: 1546, h: 776 };
    const px = { x: 748, y: 16, w: 680, h: 560 };
    expect(toPx(toFrac(px, canvas), canvas)).toEqual(px);
  });

  it('좁은 캔버스에서 커밋해도 넓은 캔버스로 돌아오면 원래 비율이 복원된다', () => {
    // 줌인 상태에서 창을 옮겨도, 줌아웃하면 그 배치가 넓은 화면에 그대로 펴져야 한다.
    const narrow = { w: 972, h: 560 };
    const wide = { w: 1546, h: 776 };
    const movedInNarrow = { x: 486, y: 280, w: 243, h: 140 };

    const stored = toFrac(movedInNarrow, narrow);
    const shown = toPx(stored, wide);

    expect(shown.x / wide.w).toBeCloseTo(0.5, 10);
    expect(shown.w / wide.w).toBeCloseTo(0.25, 10);
  });

  it('캔버스를 넘는 rect 는 크기를 살리고 위치를 밀어넣는다', () => {
    // 크기를 깎으면 경계로 드래그할 때마다 창이 야금야금 작아진다 — 위치를 민다.
    const frac = toFrac({ x: 900, y: 0, w: 200, h: 100 }, { w: 1000, h: 1000 });
    expect(frac.w).toBeCloseTo(0.2, 10);
    expect(frac.x).toBeCloseTo(0.8, 10);
    expect(frac.x + frac.w).toBeLessThanOrEqual(1);
  });

  it('크기 자체가 캔버스보다 크면 그때만 캔버스에 맞춘다', () => {
    const frac = toFrac({ x: 0, y: 0, w: 2000, h: 3000 }, { w: 1000, h: 1000 });
    expect(frac).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('캔버스가 아직 실측 전(0)이어도 나눗셈이 터지지 않는다', () => {
    expect(() => toFrac({ x: 10, y: 10, w: 10, h: 10 }, { w: 0, h: 0 })).not.toThrow();
    expect(toPx({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, { w: 0, h: 0 })).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('isFracRect 가 레거시 px 저장값을 비율로 오해하지 않는다', () => {
    expect(isFracRect({ x: 0.48, y: 0.02, w: 0.44, h: 0.72 })).toBe(true);
    // 레거시 px — 이게 true 로 새면 창이 캔버스 밖 저 멀리로 날아간다.
    expect(isFracRect({ x: 748, y: 16, w: 680, h: 560 })).toBe(false);
    expect(isFracRect({ x: 0.9, y: 0, w: 0.4, h: 0.5 })).toBe(false); // x+w > 1
    expect(isFracRect({ x: 0, y: 0, w: 0, h: 0.5 })).toBe(false); // 0 크기
  });
});

import { describe, expect, it } from 'vitest';
import { tidyLayout, type TidyWindow } from './tidy';

const CANVAS = { w: 1000, h: 800 };

describe('tidyLayout', () => {
  it('빈 입력은 빈 맵', () => {
    expect(tidyLayout([], CANVAS).size).toBe(0);
  });

  it('차트만 있으면 전체 폭을 그리드로 나눈다', () => {
    const wins: TidyWindow[] = [
      { id: 'c1', isChart: true },
      { id: 'c2', isChart: true },
    ];
    const out = tidyLayout(wins, CANVAS);
    // 2개 → 2열 1행, 각 500 폭 전체 높이
    expect(out.get('c1')).toEqual({ x: 0, y: 0, w: 500, h: 800 });
    expect(out.get('c2')).toEqual({ x: 500, y: 0, w: 500, h: 800 });
  });

  it('차트가 열 최대(3)를 넘으면 다음 행으로 감싼다', () => {
    const wins: TidyWindow[] = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, isChart: true }));
    const out = tidyLayout(wins, CANVAS);
    // 4개 → 3열 2행
    const cw = Math.round(1000 / 3);
    const ch = Math.round(800 / 2);
    expect(out.get('c0')).toEqual({ x: 0, y: 0, w: cw, h: ch });
    expect(out.get('c3')).toEqual({ x: 0, y: ch, w: cw, h: ch }); // 두 번째 행 첫 열
  });

  it('차트+데이터 혼합: 차트 좌측 그리드, 데이터 우측 스택', () => {
    const wins: TidyWindow[] = [
      { id: 'c1', isChart: true },
      { id: 'b1', isChart: false },
      { id: 'b2', isChart: false },
    ];
    const out = tidyLayout(wins, CANVAS);
    const chartW = Math.round(1000 * 0.72); // 720
    expect(out.get('c1')).toEqual({ x: 0, y: 0, w: chartW, h: 800 });
    // 데이터 2개 → 우측 열(x=720, w=280)에 세로 반분
    const dh = Math.round(800 / 2);
    expect(out.get('b1')).toEqual({ x: chartW, y: 0, w: 1000 - chartW, h: dh });
    expect(out.get('b2')).toEqual({ x: chartW, y: dh, w: 1000 - chartW, h: dh });
  });

  it('데이터만 있으면 전체 폭을 세로로 나눈다', () => {
    const wins: TidyWindow[] = [
      { id: 'b1', isChart: false },
      { id: 'b2', isChart: false },
    ];
    const out = tidyLayout(wins, CANVAS);
    expect(out.get('b1')).toEqual({ x: 0, y: 0, w: 1000, h: 400 });
    expect(out.get('b2')).toEqual({ x: 0, y: 400, w: 1000, h: 400 });
  });
});

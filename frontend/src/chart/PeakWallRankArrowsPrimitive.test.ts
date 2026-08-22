import { describe, expect, it } from 'vitest';
import {
  ARROW_GAP_PX,
  ARROW_HEIGHT_PX,
  RANK_FONT_PX,
  RANK_GAP_PX,
  rankArrowRect,
} from './PeakWallRankArrowsPrimitive';

/**
 * 순위 화살표가 차지하는 사각형(순수 기하). 고저 극값 라벨의 **회피 입력**으로도
 * 쓰이므로, 실제로 그려지는 높이(화살표 + 순위 숫자)를 빠짐없이 덮어야 한다.
 *
 * **막는 방향**: 숫자를 빼먹은 rect(=화살표 높이만) → 극값 라벨이 숫자 위에 겹친다.
 * **못 보는 것**: 렌더러가 이 rect 와 같은 자리에 실제로 그리는지 — 상수를 공유하므로
 * 갈리려면 렌더러가 상수를 안 쓰는 쪽으로 바뀌어야 한다.
 */
describe('rankArrowRect', () => {
  const TOTAL = ARROW_GAP_PX + ARROW_HEIGHT_PX + RANK_GAP_PX + RANK_FONT_PX;

  it('매도는 앵커(캔들 고가) **위쪽**을 차지한다', () => {
    const r = rankArrowRect(100, 'ask', 50);
    expect(r.bottom).toBe(100);
    expect(r.top).toBe(100 - TOTAL);
    expect(r.left).toBeLessThan(50);
    expect(r.right).toBeGreaterThan(50);
  });

  it('매수는 앵커(캔들 저가) **아래쪽**을 차지한다(매도의 거울)', () => {
    const r = rankArrowRect(100, 'bid', 50);
    expect(r.top).toBe(100);
    expect(r.bottom).toBe(100 + TOTAL);
  });

  it('높이에 순위 숫자 자리가 포함된다', () => {
    const r = rankArrowRect(0, 'ask', 0);
    // 화살표만 덮으면 숫자가 rect 밖으로 나가 회피가 숫자를 못 본다.
    expect(r.bottom - r.top).toBeGreaterThan(ARROW_GAP_PX + ARROW_HEIGHT_PX);
  });

  it('폭은 x 를 중심으로 대칭이다', () => {
    const r = rankArrowRect(0, 'ask', 200);
    expect(200 - r.left).toBeCloseTo(r.right - 200);
  });
});

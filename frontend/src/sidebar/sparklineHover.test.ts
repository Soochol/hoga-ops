import { describe, expect, it } from 'vitest';

import { hoverMsFromClientX, valueFromYRatio } from './sparklineHover';

const T0 = 1_000_000;
const T1 = 1_060_000; // +60초

describe('hoverMsFromClientX', () => {
  it('maps the left edge to tFirst and the right edge to tLast', () => {
    // 플롯: left=100, width=200 → [100,300] 픽셀이 [T0,T1] 시각에 대응.
    expect(hoverMsFromClientX(100, 100, 200, T0, T1)).toBe(T0);
    expect(hoverMsFromClientX(300, 100, 200, T0, T1)).toBe(T1);
  });

  it('maps the midpoint to the middle of the time domain', () => {
    expect(hoverMsFromClientX(200, 100, 200, T0, T1)).toBe((T0 + T1) / 2);
  });

  it('returns null past the left edge (no clamp to tFirst)', () => {
    // 좁은 grid 열에서 인접 열/divider 경계에 걸치면 x 가 플롯 밖이다 —
    // 끝값으로 붙이지 않고 커서를 끈다(거래원 divider 우측 점프 방지).
    expect(hoverMsFromClientX(40, 100, 200, T0, T1)).toBeNull();
  });

  it('returns null past the right edge (no clamp to tLast)', () => {
    expect(hoverMsFromClientX(9_999, 100, 200, T0, T1)).toBeNull();
  });

  it('keeps the exact edges (ratio 0 and 1 are in-range)', () => {
    // 경계 자체는 플롯 안 — 끝값을 정확히 읽는다.
    expect(hoverMsFromClientX(100, 100, 200, T0, T1)).toBe(T0);
    expect(hoverMsFromClientX(300, 100, 200, T0, T1)).toBe(T1);
  });

  it('returns null for a zero-width rect (unmeasurable plot)', () => {
    // jsdom 이 rect 를 0 으로 주는 경우 — 호버를 무시해야 한다.
    expect(hoverMsFromClientX(150, 100, 0, T0, T1)).toBeNull();
  });
});

describe('valueFromYRatio', () => {
  it('maps the top of the plot to vMax and the bottom to vMin', () => {
    expect(valueFromYRatio(0, -50, 200)).toBe(200);
    expect(valueFromYRatio(1, -50, 200)).toBe(-50);
  });

  it('maps the midpoint to the domain center', () => {
    expect(valueFromYRatio(0.5, 0, 100)).toBe(50);
  });

  it('reads the mouse height, not a snapped curve value (linear in ratio)', () => {
    // r=0.25 → 위에서 1/4 지점 = vMax 쪽으로 3/4. 곡선과 무관한 순수 높이.
    expect(valueFromYRatio(0.25, 0, 100)).toBe(75);
  });
});

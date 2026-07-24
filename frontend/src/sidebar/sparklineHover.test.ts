import { describe, expect, it } from 'vitest';

import { hoverMsFromClientX } from './sparklineHover';

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

  it('clamps past the left edge to tFirst (no negative overshoot)', () => {
    expect(hoverMsFromClientX(40, 100, 200, T0, T1)).toBe(T0);
  });

  it('clamps past the right edge to tLast (no overshoot beyond last)', () => {
    expect(hoverMsFromClientX(9_999, 100, 200, T0, T1)).toBe(T1);
  });

  it('returns null for a zero-width rect (unmeasurable plot)', () => {
    // jsdom 이 rect 를 0 으로 주는 경우 — 호버를 무시해야 한다.
    expect(hoverMsFromClientX(150, 100, 0, T0, T1)).toBeNull();
  });
});

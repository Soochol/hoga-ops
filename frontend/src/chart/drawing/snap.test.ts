import { describe, expect, it } from 'vitest';
import { constrainAngle } from './snap';

describe('constrainAngle', () => {
  it('snaps a near-horizontal drag to horizontal', () => {
    const out = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 8 });
    expect(out.y).toBeCloseTo(0, 5);
    expect(out.x).toBeGreaterThan(90);
  });
  it('snaps a near-45° drag to exactly 45°', () => {
    const out = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 90 });
    expect(Math.abs(out.x)).toBeCloseTo(Math.abs(out.y), 5);
  });
  it('snaps a near-vertical drag to vertical', () => {
    const out = constrainAngle({ x: 0, y: 0 }, { x: 6, y: 100 });
    expect(out.x).toBeCloseTo(0, 5);
  });
});

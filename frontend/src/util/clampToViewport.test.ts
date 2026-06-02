import { describe, it, expect } from 'vitest';
import { clampToViewport } from './clampToViewport';

describe('clampToViewport', () => {
  it('keeps a fully-visible layer at its desired position', () => {
    expect(clampToViewport(10, 20, 100, 40, 1000, 800)).toEqual({ left: 10, top: 20 });
  });

  it('slides a right-overflowing layer back to the right edge', () => {
    expect(clampToViewport(950, 20, 100, 40, 1000, 800)).toEqual({ left: 900, top: 20 });
  });

  it('slides a bottom-overflowing layer up to the bottom edge', () => {
    expect(clampToViewport(10, 790, 100, 40, 1000, 800)).toEqual({ left: 10, top: 760 });
  });

  it('floors at 0 on both axes when the layer is larger than the viewport', () => {
    expect(clampToViewport(50, 50, 1200, 900, 1000, 800)).toEqual({ left: 0, top: 0 });
  });

  it('clamps both axes independently', () => {
    expect(clampToViewport(950, 790, 100, 40, 1000, 800)).toEqual({ left: 900, top: 760 });
  });

  it('floors a negative desired position at 0 on both axes', () => {
    expect(clampToViewport(-30, -10, 100, 40, 1000, 800)).toEqual({ left: 0, top: 0 });
  });
});

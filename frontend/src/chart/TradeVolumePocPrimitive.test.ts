import { describe, expect, it } from 'vitest';
import { TradeVolumePocPrimitive } from './TradeVolumePocPrimitive';

describe('TradeVolumePocPrimitive', () => {
  it('defaults to the normal primitive layer', () => {
    const primitive = new TradeVolumePocPrimitive();

    expect(primitive.paneViews()[0].zOrder?.()).toBe('normal');
  });

  it('can draw below the series layer', () => {
    const primitive = new TradeVolumePocPrimitive({ zOrder: 'bottom' });

    expect(primitive.paneViews()[0].zOrder?.()).toBe('bottom');
  });
});

import { describe, expect, it } from 'vitest';
import { colorContrast } from './colorContrast';
import { DEFAULT_LIVE_MAS } from '../../state/liveIndicatorsPersistence';

describe('indicator contrast', () => {
  it('detects the old white MA on light backgrounds and preserves unknown formats', () => {
    expect(colorContrast('#F8FAFC', '#FFFFFF')).toBeLessThan(1.1);
    expect(colorContrast('#000000', '#ffffff')).toBe(21);
    expect(colorContrast('#000', '#fff')).toBe(21);
    expect(colorContrast('#F8FAFC', '#fff')).toBeLessThan(1.1);
    expect(colorContrast('transparent', '#ffffff')).toBeNull();
  });
  it('keeps the default 120 line distinguishable on light and dark backgrounds', () => {
    const color = DEFAULT_LIVE_MAS.find((ma) => ma.period === 120)!.color;
    for (const background of ['#FFFFFF', '#F7F5F0', '#13131C', '#17171C']) {
      expect(colorContrast(color, background)).toBeGreaterThanOrEqual(3);
    }
  });
});

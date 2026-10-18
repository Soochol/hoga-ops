import { describe, expect, it } from 'vitest';
import { resolveMaColor } from './maColor';
import { colorContrast } from '../live/indicators/colorContrast';
import { DEFAULT_DAILY_MAS, DEFAULT_LIVE_MAS, mergeLiveIndicatorPrefs } from '../state/liveIndicatorsPersistence';
import { INDICATOR_OPS, MA_PALETTE } from '../state/indicatorOps';
import { FACTORY_INDICATOR_SETTINGS } from '../state/indicatorSettingsV2';

const backgrounds = {
  obsidian: '#121216', 'obsidian-pro': '#171A20', 'toss-dark': '#17171C',
  ledger: '#FDFCF8', 'ledger-studio': '#FFFEFA', 'toss-light': '#FFFFFF',
};

describe('automatic moving average colors', () => {
  it('defaults both MA types and newly added slots to automatic', () => {
    expect([...DEFAULT_LIVE_MAS, ...DEFAULT_DAILY_MAS].every(m => m.colorMode === 'auto')).toBe(true);
    expect(INDICATOR_OPS.addMovingAverage(FACTORY_INDICATOR_SETTINGS)?.movingAverages?.at(-1)?.colorMode).toBe('auto');
    expect(INDICATOR_OPS.addDailyMovingAverage(FACTORY_INDICATOR_SETTINGS)?.dailyMovingAverages?.at(-1)?.colorMode).toBe('auto');
  });

  it('provides readable, distinct colors for every assigned hue in all six themes', () => {
    for (const [theme, background] of Object.entries(backgrounds)) {
      const colors = MA_PALETTE.map(color => resolveMaColor({ color, colorMode: 'auto' }, theme));
      expect(new Set(colors).size).toBe(MA_PALETTE.length);
      for (const color of colors) expect(colorContrast(color, background)).toBeGreaterThanOrEqual(4.5);
      for (const color of ['#000000', '#FFFFFF', '#ABCDEF', '#751234']) {
        expect(colorContrast(resolveMaColor({ color, colorMode: 'auto' }, theme), background)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(resolveMaColor({ color: '#6B7280', colorMode: 'auto' }, 'toss-light')).toBe('#374151');
    expect(resolveMaColor({ color: '#6B7280', colorMode: 'auto' }, 'toss-dark')).toBe('#CBD5E1');
  });

  it('preserves legacy and explicit manual colors, even when identical to a factory hue', () => {
    for (const theme of Object.keys(backgrounds)) {
      expect(resolveMaColor({ color: '#000000' }, theme)).toBe('#000000');
      expect(resolveMaColor({ color: '#EC4899', colorMode: 'manual' }, theme)).toBe('#EC4899');
    }
  });

  it('retains modes through persistence and treats legacy slots as manual for both types', () => {
    const slots = [
      { ...DEFAULT_LIVE_MAS[0], id: 'auto' },
      { ...DEFAULT_LIVE_MAS[0], id: 'manual', colorMode: 'manual' as const },
      { ...DEFAULT_LIVE_MAS[0], id: 'legacy', colorMode: undefined, color: '#000000' },
      { ...DEFAULT_LIVE_MAS[0], id: 'invalid', colorMode: 'corrupt' },
    ];
    const restored = mergeLiveIndicatorPrefs(JSON.parse(JSON.stringify({ movingAverages: slots, dailyMovingAverages: slots })));
    for (const configs of [restored.movingAverages, restored.dailyMovingAverages]) {
      expect(configs.map(m => m.colorMode)).toEqual(['auto', 'manual', undefined, undefined]);
      expect(configs[2].color).toBe('#000000');
    }
  });

  it('switches to manual only for color changes, and can return to automatic without losing the hue', () => {
    const cur = FACTORY_INDICATOR_SETTINGS;
    for (const [key, set] of [['movingAverages', INDICATOR_OPS.setMovingAverage], ['dailyMovingAverages', INDICATOR_OPS.setDailyMovingAverage]] as const) {
      const slot = cur[key][0];
      expect(set(cur, slot.id, { lineWidth: 3 })?.[key]?.[0].colorMode).toBe('auto');
      const manual = set(cur, slot.id, { color: '#000000' })!;
      expect(manual[key]![0]).toMatchObject({ color: '#000000', colorMode: 'manual' });
      const auto = set({ ...cur, ...manual }, slot.id, { colorMode: 'auto' })!;
      expect(auto[key]![0]).toMatchObject({ color: '#000000', colorMode: 'auto' });
    }
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('liveLayout store helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('falls back to defaults when storage is corrupt', async () => {
    localStorage.setItem('live.layout.v1', JSON.stringify({
      rightPanelWidthPx: -10,
      rightCardWeights: {
        orderbook: Number.NaN,
        program: 'bad',
        brokers: Infinity,
        investor: -1,
      },
    }));

    const { useLiveLayoutStore, DEFAULT_RIGHT_PANEL_WIDTH_PX, DEFAULT_CARD_WEIGHTS } =
      await import('./liveLayout');

    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(DEFAULT_RIGHT_PANEL_WIDTH_PX);
    expect(useLiveLayoutStore.getState().rightCardWeights).toEqual(DEFAULT_CARD_WEIGHTS);
  });

  it('clamps detail width against current workarea width', async () => {
    const { clampRightPanelWidth } = await import('./liveLayout');

    expect(clampRightPanelWidth(500, 2000)).toBe(500);
    expect(clampRightPanelWidth(100, 2000)).toBe(320);
    expect(clampRightPanelWidth(1200, 2000)).toBe(900);
    expect(clampRightPanelWidth(600, 850)).toBe(320);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('liveLayout store helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('falls back to defaults when persisted weights are partially corrupt', async () => {
    localStorage.setItem('live.layout.v1', JSON.stringify({
      rightPanelWidthPx: 512,
      rightCardWeights: {
        orderbook: 40,
        program: 'bad',
        brokers: 25,
        investor: 15,
      },
    }));

    const { useLiveLayoutStore, DEFAULT_RIGHT_PANEL_WIDTH_PX, DEFAULT_CARD_WEIGHTS } =
      await import('./liveLayout');

    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(512);
    expect(useLiveLayoutStore.getState().rightCardWeights).toEqual(DEFAULT_CARD_WEIGHTS);
  });

  it('migrates valid four-card weights by adding the default volume distribution weight', async () => {
    localStorage.setItem('live.layout.v1', JSON.stringify({
      rightPanelWidthPx: 512,
      rightCardWeights: {
        orderbook: 48,
        program: 13,
        brokers: 24,
        investor: 15,
      },
    }));

    const { useLiveLayoutStore, DEFAULT_CARD_WEIGHTS } = await import('./liveLayout');

    expect(useLiveLayoutStore.getState().rightCardWeights).toEqual({
      orderbook: 48,
      volumeDistribution: DEFAULT_CARD_WEIGHTS.volumeDistribution,
      program: 13,
      brokers: 24,
      investor: 15,
    });
  });

  it('sanitizes width before persisting it', async () => {
    const { useLiveLayoutStore, DEFAULT_RIGHT_PANEL_WIDTH_PX } = await import('./liveLayout');

    useLiveLayoutStore.getState().setRightPanelWidthPx(412.7);

    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(413);
    expect(JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}').rightPanelWidthPx).toBe(413);

    useLiveLayoutStore.getState().setRightPanelWidthPx(0);

    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(DEFAULT_RIGHT_PANEL_WIDTH_PX);
    expect(JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}').rightPanelWidthPx)
      .toBe(DEFAULT_RIGHT_PANEL_WIDTH_PX);
  });

  it('clamps detail width against current workarea width', async () => {
    const { clampRightPanelWidth, LIVE_WORKAREA_SPLITTER_WIDTH_PX } = await import('./liveLayout');

    expect(clampRightPanelWidth(500, 2000)).toBe(500);
    expect(clampRightPanelWidth(100, 2000)).toBe(320);
    expect(clampRightPanelWidth(1200, 2000)).toBe(900);
    expect(clampRightPanelWidth(600, 850)).toBe(320);
    expect(clampRightPanelWidth(700, 966, LIVE_WORKAREA_SPLITTER_WIDTH_PX)).toBe(320);
  });

  it('resizes adjacent weights without disturbing the rest of the layout', async () => {
    const { DEFAULT_CARD_WEIGHTS, resizeAdjacentWeights } = await import('./liveLayout');

    const next = resizeAdjacentWeights(DEFAULT_CARD_WEIGHTS, 'orderbook', 'program', 80, 800);

    expect(next.brokers).toBe(DEFAULT_CARD_WEIGHTS.brokers);
    expect(next.investor).toBe(DEFAULT_CARD_WEIGHTS.investor);
    expect(next.orderbook + next.program).toBeCloseTo(
      DEFAULT_CARD_WEIGHTS.orderbook + DEFAULT_CARD_WEIGHTS.program,
      6,
    );
    expect(next.orderbook).toBeGreaterThan(DEFAULT_CARD_WEIGHTS.orderbook);
    expect(next.program).toBeLessThan(DEFAULT_CARD_WEIGHTS.program);
  });
});

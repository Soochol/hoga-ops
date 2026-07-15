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

    const { useLiveLayoutStore, DEFAULT_CARD_WEIGHTS } = await import('./liveLayout');

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

  it('hydrates legacy payloads (width + weights only) to expanded defaults', async () => {
    localStorage.setItem('live.layout.v1', JSON.stringify({
      rightPanelWidthPx: 480,
      rightCardWeights: {
        orderbook: 34,
        volumeDistribution: 18,
        program: 12,
        brokers: 22,
        investor: 14,
      },
    }));

    const { useLiveLayoutStore } = await import('./liveLayout');

    expect(useLiveLayoutStore.getState().rightCardCollapsed).toEqual({});
    expect(useLiveLayoutStore.getState().detailPanelCollapsed).toBe(false);
  });

  it('drops corrupt collapse entries per key instead of nuking the whole map', async () => {
    localStorage.setItem('live.layout.v1', JSON.stringify({
      rightCardCollapsed: {
        orderbook: true,
        brokers: 'yes',
        bogus: true,
        program: false,
      },
      detailPanelCollapsed: 'nope',
    }));

    const { useLiveLayoutStore } = await import('./liveLayout');

    expect(useLiveLayoutStore.getState().rightCardCollapsed).toEqual({
      orderbook: true,
      program: false,
    });
    expect(useLiveLayoutStore.getState().detailPanelCollapsed).toBe(false);
  });

  it('keeps persisted fields intact after a width write (persist centralization)', async () => {
    const { useLiveLayoutStore } = await import('./liveLayout');

    useLiveLayoutStore.getState().setDetailPanelCollapsed(true);
    useLiveLayoutStore.getState().setRightPanelWidthPx(420);

    const persisted = JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}');
    expect(persisted.rightPanelWidthPx).toBe(420);
    expect(persisted.detailPanelCollapsed).toBe(true);
  });

  it('toggles the whole detail panel collapse flag', async () => {
    const { useLiveLayoutStore } = await import('./liveLayout');

    expect(useLiveLayoutStore.getState().detailPanelCollapsed).toBe(false);
    useLiveLayoutStore.getState().toggleDetailPanelCollapsed();
    expect(useLiveLayoutStore.getState().detailPanelCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}').detailPanelCollapsed).toBe(true);
    useLiveLayoutStore.getState().toggleDetailPanelCollapsed();
    expect(useLiveLayoutStore.getState().detailPanelCollapsed).toBe(false);
  });

  it('defaults card order to the canonical render order and hidden to empty', async () => {
    const { useLiveLayoutStore, LIVE_CARD_KEYS } = await import('./liveLayout');

    expect(useLiveLayoutStore.getState().rightCardOrder).toEqual([...LIVE_CARD_KEYS]);
    expect(useLiveLayoutStore.getState().rightCardHidden).toEqual({});
  });

  it('normalizes a persisted card order: unknown dropped, missing appended', async () => {
    localStorage.setItem('live.layout.v1', JSON.stringify({
      rightCardOrder: ['program', 'bogus', 'orderbook'],
    }));

    const { useLiveLayoutStore } = await import('./liveLayout');

    // program, orderbook 유지 → 누락(brokers, volumeDistribution, investor) canonical 순서로 append.
    expect(useLiveLayoutStore.getState().rightCardOrder).toEqual([
      'program', 'orderbook', 'brokers', 'volumeDistribution', 'investor',
    ]);
  });

  it('persists order + hidden after a width write (persist centralization)', async () => {
    const { useLiveLayoutStore } = await import('./liveLayout');

    useLiveLayoutStore.getState().setRightCardOrder(['investor', 'orderbook']);
    useLiveLayoutStore.getState().setCardHidden('program', true);
    useLiveLayoutStore.getState().setRightPanelWidthPx(420);

    const persisted = JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}');
    expect(persisted.rightPanelWidthPx).toBe(420);
    expect(persisted.rightCardOrder).toEqual([
      'investor', 'orderbook', 'brokers', 'volumeDistribution', 'program',
    ]);
    expect(persisted.rightCardHidden).toEqual({ program: true });
  });

  it('round-trips lastAppliedPresetId and applies a layout preset in one write', async () => {
    localStorage.setItem('live.layout.v1', JSON.stringify({ lastAppliedPresetId: 'preset-x' }));
    const { useLiveLayoutStore } = await import('./liveLayout');
    expect(useLiveLayoutStore.getState().lastAppliedPresetId).toBe('preset-x');

    useLiveLayoutStore.getState().applyLayoutPreset({
      rightPanelWidthPx: 455,
      rightCardOrder: ['investor', 'bogus', 'orderbook'] as never,
      rightCardHidden: { program: true },
      rightCardCollapsed: { brokers: true },
      rightCardWeights: { orderbook: 30, brokers: 20, volumeDistribution: 20, program: 15, investor: 15 },
      lastAppliedPresetId: 'preset-y',
    });

    const s = useLiveLayoutStore.getState();
    expect(s.rightPanelWidthPx).toBe(455);
    // 미지의 카드 키 드롭 + 누락 append 정규화.
    expect(s.rightCardOrder).toEqual(['investor', 'orderbook', 'brokers', 'volumeDistribution', 'program']);
    expect(s.rightCardHidden).toEqual({ program: true });
    expect(s.lastAppliedPresetId).toBe('preset-y');

    const persisted = JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}');
    expect(persisted.rightPanelWidthPx).toBe(455);
    expect(persisted.lastAppliedPresetId).toBe('preset-y');
  });

  it('hiding a card leaves weights and (preset-carried) collapse untouched', async () => {
    const { useLiveLayoutStore, DEFAULT_CARD_WEIGHTS } = await import('./liveLayout');

    // collapse 필드는 프리셋 캡처/적용용으로만 남아 있다(setter 제거) — 직접 세팅.
    useLiveLayoutStore.setState({ rightCardCollapsed: { brokers: true } });
    useLiveLayoutStore.getState().setCardHidden('brokers', true);

    expect(useLiveLayoutStore.getState().rightCardWeights).toEqual(DEFAULT_CARD_WEIGHTS);
    expect(useLiveLayoutStore.getState().rightCardCollapsed.brokers).toBe(true);

    useLiveLayoutStore.getState().setCardHidden('brokers', false);
    expect(useLiveLayoutStore.getState().rightCardCollapsed.brokers).toBe(true);
  });
});

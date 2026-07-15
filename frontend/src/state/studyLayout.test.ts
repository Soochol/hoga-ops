import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('studyLayout store', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('defaults to expanded cards and expanded panel with no persisted state', async () => {
    const { useStudyLayoutStore } = await import('./studyLayout');
    expect(useStudyLayoutStore.getState().cardCollapsed).toEqual({});
    expect(useStudyLayoutStore.getState().detailPanelCollapsed).toBe(false);
  });

  it('drops corrupt collapse entries per key', async () => {
    localStorage.setItem('study.layout.v1', JSON.stringify({
      cardCollapsed: { orderbook: true, brokers: 1, bogus: true, program: false },
      detailPanelCollapsed: 'x',
    }));

    const { useStudyLayoutStore } = await import('./studyLayout');
    expect(useStudyLayoutStore.getState().cardCollapsed).toEqual({ orderbook: true, program: false });
    expect(useStudyLayoutStore.getState().detailPanelCollapsed).toBe(false);
  });

  it('toggles the detail panel and persists', async () => {
    const { useStudyLayoutStore } = await import('./studyLayout');

    useStudyLayoutStore.getState().toggleDetailPanelCollapsed();
    expect(useStudyLayoutStore.getState().detailPanelCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem('study.layout.v1') ?? '{}').detailPanelCollapsed).toBe(true);
  });

  it('defaults order to canonical keys and hidden to empty', async () => {
    const { useStudyLayoutStore, STUDY_CARD_KEYS } = await import('./studyLayout');
    expect(useStudyLayoutStore.getState().cardOrder).toEqual([...STUDY_CARD_KEYS]);
    expect(useStudyLayoutStore.getState().cardHidden).toEqual({});
  });

  it('normalizes persisted order and persists order/hidden setters', async () => {
    localStorage.setItem('study.layout.v1', JSON.stringify({
      cardOrder: ['program', 'bogus', 'orderbook'],
    }));

    const { useStudyLayoutStore } = await import('./studyLayout');
    expect(useStudyLayoutStore.getState().cardOrder).toEqual([
      'program', 'orderbook', 'brokers', 'volumeDistribution',
    ]);

    useStudyLayoutStore.getState().setCardHidden('program', true);
    useStudyLayoutStore.getState().setCardOrder(['brokers', 'orderbook']);
    const persisted = JSON.parse(localStorage.getItem('study.layout.v1') ?? '{}');
    expect(persisted.cardHidden).toEqual({ program: true });
    expect(persisted.cardOrder).toEqual([
      'brokers', 'orderbook', 'volumeDistribution', 'program',
    ]);
  });
});

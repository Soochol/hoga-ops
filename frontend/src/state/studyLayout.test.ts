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

  it('toggles cards and persists, collapses/expands all, toggles the panel', async () => {
    const { useStudyLayoutStore } = await import('./studyLayout');

    useStudyLayoutStore.getState().toggleCardCollapsed('volumeDistribution');
    expect(useStudyLayoutStore.getState().cardCollapsed.volumeDistribution).toBe(true);
    expect(JSON.parse(localStorage.getItem('study.layout.v1') ?? '{}').cardCollapsed.volumeDistribution).toBe(true);

    useStudyLayoutStore.getState().setAllCardsCollapsed(true);
    expect(useStudyLayoutStore.getState().cardCollapsed).toEqual({
      orderbook: true,
      brokers: true,
      volumeDistribution: true,
      program: true,
    });

    useStudyLayoutStore.getState().toggleDetailPanelCollapsed();
    expect(useStudyLayoutStore.getState().detailPanelCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem('study.layout.v1') ?? '{}').detailPanelCollapsed).toBe(true);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useScreenerPanelStore, type PanelScan } from './screenerPanel';

const SCAN: PanelScan = {
  savedId: 's1', savedName: '돌파', rows: [], scanStatus: 'ok', warnings: [],
};

describe('screenerPanel store', () => {
  beforeEach(() => {
    localStorage.clear();
    useScreenerPanelStore.setState({ selectedSavedId: null, lastScan: null });
  });

  it('setSelectedSavedId sets and persists', () => {
    useScreenerPanelStore.getState().setSelectedSavedId('s1');
    expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1');
    expect(JSON.parse(localStorage.getItem('screenerPanel.v1')!).selectedSavedId).toBe('s1');
  });

  it('setLastScan stores in memory and does NOT persist', () => {
    useScreenerPanelStore.getState().setLastScan(SCAN);
    expect(useScreenerPanelStore.getState().lastScan).toEqual(SCAN);
    const raw = localStorage.getItem('screenerPanel.v1');
    expect(raw === null || JSON.parse(raw).lastScan === undefined).toBe(true);
  });

  it('clearScan empties lastScan', () => {
    useScreenerPanelStore.getState().setLastScan(SCAN);
    useScreenerPanelStore.getState().clearScan();
    expect(useScreenerPanelStore.getState().lastScan).toBeNull();
  });

  it('hydrates selectedSavedId from storage; lastScan starts null', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({ selectedSavedId: 's9' }));
    vi.resetModules();
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().selectedSavedId).toBe('s9');
    expect(fresh.getState().lastScan).toBeNull();
  });

  it('rejects corrupt selectedSavedId (non-string, non-null) → default null', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({ selectedSavedId: 42 }));
    vi.resetModules();
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().selectedSavedId).toBeNull();
  });
});

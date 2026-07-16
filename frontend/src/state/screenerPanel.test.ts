import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SCREENER_PANEL_SCAN_TTL_MS,
  isPanelScanFresh,
  useScreenerPanelStore,
  type PanelScan,
} from './screenerPanel';

const NOW = 1_800_000_000_000;

const SCAN: PanelScan = {
  savedId: 's1',
  savedName: '돌파',
  savedUpdatedAtMs: 10,
  scanKey: null,
  rows: [
    {
      code: '005930',
      name: '삼성전자',
      market: 'KOSPI',
      price: 70000,
      trade_value_won: 100_000_000_000,
      change_pct: 2.1,
    },
  ],
  scanStatus: 'ok',
  warnings: [],
  depthValues: null,
  scannedAtMs: NOW,
  basis: 'intraday',
  dataStale: false,
};

describe('screenerPanel store', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useScreenerPanelStore.setState({
      selectedSavedId: null,
      lastScan: null,
      sortMode: 'default',
      updateState: { status: 'idle' },
      monitoringActive: false,
      monitorPeriodMs: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists selected save, last scan, and sort mode', () => {
    useScreenerPanelStore.getState().setSelectedSavedId('s1');
    useScreenerPanelStore.getState().setLastScan(SCAN);
    useScreenerPanelStore.getState().setSortMode({ field: 'change_pct', direction: 'desc' });

    const persisted = JSON.parse(localStorage.getItem('screenerPanel.v1')!);
    expect(persisted.selectedSavedId).toBe('s1');
    expect(persisted.lastScan).toMatchObject({
      savedId: 's1',
      savedUpdatedAtMs: 10,
      scannedAtMs: NOW,
      basis: 'intraday',
      dataStale: false,
    });
    expect(persisted.sortMode).toEqual({ field: 'change_pct', direction: 'desc' });
  });

  it('hydrates a fresh saved scan and sort mode from storage', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({
      selectedSavedId: 's1',
      lastScan: SCAN,
      sortMode: { field: 'price', direction: 'asc' },
    }));
    vi.resetModules();
    vi.setSystemTime(NOW);

    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');

    expect(fresh.getState().selectedSavedId).toBe('s1');
    expect(fresh.getState().lastScan).toEqual(SCAN);
    expect(fresh.getState().sortMode).toEqual({ field: 'price', direction: 'asc' });
    expect(fresh.getState().updateState).toEqual({ status: 'idle' });
  });

  it('drops expired saved scans during hydration but keeps selectedSavedId', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({
      selectedSavedId: 's1',
      lastScan: { ...SCAN, scannedAtMs: NOW - SCREENER_PANEL_SCAN_TTL_MS - 1 },
      sortMode: { field: 'price', direction: 'asc' },
    }));
    vi.resetModules();
    vi.setSystemTime(NOW);

    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');

    expect(fresh.getState().selectedSavedId).toBe('s1');
    expect(fresh.getState().lastScan).toBeNull();
    expect(fresh.getState().sortMode).toEqual({ field: 'price', direction: 'asc' });
  });

  it('rejects corrupt scan rows and corrupt sort mode', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({
      selectedSavedId: 's1',
      lastScan: { ...SCAN, rows: [{ code: 5930 }] },
      sortMode: { field: 'bad', direction: 'sideways' },
    }));
    vi.resetModules();
    vi.setSystemTime(NOW);

    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');

    expect(fresh.getState().selectedSavedId).toBe('s1');
    expect(fresh.getState().lastScan).toBeNull();
    expect(fresh.getState().sortMode).toBe('default');
  });

  it('migrates a legacy scan without scanKey/depthValues by filling nulls', async () => {
    // 단일 뷰 시절 데이터: saved* 필수, scanKey/depthValues 없음. 키는 v1 유지이므로
    // 누락 필드를 null 로 채워 통과해야 한다(하위호환).
    localStorage.setItem('screenerPanel.v1', JSON.stringify({
      selectedSavedId: 's1',
      lastScan: {
        savedId: 's1',
        savedName: '돌파',
        savedUpdatedAtMs: 10,
        rows: SCAN.rows,
        scanStatus: 'ok',
        warnings: [],
        scannedAtMs: NOW,
        basis: 'intraday',
        dataStale: false,
      },
    }));
    vi.resetModules();
    vi.setSystemTime(NOW);

    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');

    expect(fresh.getState().lastScan).toEqual(SCAN);
  });

  it('hydrates a page-style scan (null savedId, scanKey + depthValues)', async () => {
    const pageScan: PanelScan = {
      ...SCAN,
      savedId: null,
      savedName: null,
      savedUpdatedAtMs: null,
      scanKey: '{"conditions":[],"universe":{},"basis":"intraday"}',
      depthValues: {
        '005930': {
          ask_today: 1000, ask_past_peak: 900, ask_have_days: 5, ask_need_days: 5,
          bid_today: null, bid_past_peak: null, bid_have_days: 0, bid_need_days: 5,
        },
      },
    };
    localStorage.setItem('screenerPanel.v1', JSON.stringify({ lastScan: pageScan }));
    vi.resetModules();
    vi.setSystemTime(NOW);

    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');

    expect(fresh.getState().lastScan).toEqual(pageScan);
  });

  it('rejects a scan with corrupt depthValues', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({
      lastScan: { ...SCAN, depthValues: { '005930': { ask_today: 'nope' } } },
    }));
    vi.resetModules();
    vi.setSystemTime(NOW);

    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');

    expect(fresh.getState().lastScan).toBeNull();
  });

  it('marks the last scan stale after data update succeeds', () => {
    useScreenerPanelStore.getState().setLastScan(SCAN);
    useScreenerPanelStore.getState().markLastScanDataStale();
    expect(useScreenerPanelStore.getState().lastScan?.dataStale).toBe(true);
  });

  it('persists monitoringActive and re-hydrates it (auto-resume across reloads)', async () => {
    useScreenerPanelStore.getState().setMonitoringActive(true);
    expect(JSON.parse(localStorage.getItem('screenerPanel.v1')!).monitoringActive).toBe(true);

    vi.resetModules();
    vi.setSystemTime(NOW);
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().monitoringActive).toBe(true);
  });

  it('defaults monitoringActive to false when absent from storage', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({ selectedSavedId: 's1' }));
    vi.resetModules();
    vi.setSystemTime(NOW);
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().monitoringActive).toBe(false);
  });

  it('persists and re-hydrates a valid monitorPeriodMs, rejecting unknown values', async () => {
    useScreenerPanelStore.getState().setMonitorPeriodMs(30_000);
    expect(JSON.parse(localStorage.getItem('screenerPanel.v1')!).monitorPeriodMs).toBe(30_000);
    vi.resetModules();
    vi.setSystemTime(NOW);
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().monitorPeriodMs).toBe(30_000);

    // 목록에 없는 값은 기각 → default(null=자동)로 폴백.
    localStorage.setItem('screenerPanel.v1', JSON.stringify({ monitorPeriodMs: 7_777 }));
    vi.resetModules();
    vi.setSystemTime(NOW);
    const { useScreenerPanelStore: rejected } = await import('./screenerPanel');
    expect(rejected.getState().monitorPeriodMs).toBeNull();
  });

  it('persists terminal update status across short reloads without restoring pending', async () => {
    useScreenerPanelStore.getState().setSelectedSavedId('s1');
    useScreenerPanelStore.getState().setUpdatePending(NOW);
    useScreenerPanelStore.getState().setUpdateError('boom', NOW + 5);

    expect(useScreenerPanelStore.getState().updateState).toEqual({
      status: 'error',
      startedAtMs: NOW,
      finishedAtMs: NOW + 5,
      message: 'boom',
    });
    expect(JSON.parse(localStorage.getItem('screenerPanel.v1')!).updateState).toMatchObject({
      status: 'error',
      message: 'boom',
    });

    vi.resetModules();
    vi.setSystemTime(NOW + 6);
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().updateState).toMatchObject({
      status: 'error',
      message: 'boom',
    });

    localStorage.setItem('screenerPanel.v1', JSON.stringify({
      selectedSavedId: 's1',
      updateState: { status: 'pending', startedAtMs: NOW },
    }));
    vi.resetModules();
    vi.setSystemTime(NOW + 10);
    const { useScreenerPanelStore: pendingFresh } = await import('./screenerPanel');
    expect(pendingFresh.getState().updateState).toEqual({ status: 'idle' });
  });

  it('classifies scan freshness by ttl', () => {
    expect(isPanelScanFresh(SCAN, NOW + SCREENER_PANEL_SCAN_TTL_MS)).toBe(true);
    expect(isPanelScanFresh(SCAN, NOW + SCREENER_PANEL_SCAN_TTL_MS + 1)).toBe(false);
    expect(isPanelScanFresh({ ...SCAN, scannedAtMs: NOW + 1 }, NOW)).toBe(false);
  });
});

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
  requestJson: '{"conditions":[],"universe":{},"basis":"intraday"}',
  rows: [
    {
      code: '005930',
      name: '삼성전자',
      market: 'KOSPI',
      price: 70000,
      trade_value_won: 100_000_000_000,
      change_pct: 2.1,
      price_date: '2026-09-07',
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
  it('retains automatic selection and server cutoffs across storage reloads', async () => {
    const scan: PanelScan = { ...SCAN, basis: 'auto', basisAtMs: NOW - 60000,
      fallbackBasisAtMs: NOW - 86400000, requestJson: '{"basis":"auto","conditions":[],"universe":{}}' };
    useScreenerPanelStore.getState().setLastScan(scan);
    vi.resetModules();
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().lastScan).toEqual(scan);
  });
  it.each(['requestJson', 'scanKey'])('drops a closed-only snapshot identified by %s', async field => {
    const request = JSON.stringify({ conditions: [{ id: 'c', type: 'ma',
      params: { period: 20, relation: 'above', include_open_bar: false } }] });
    localStorage.setItem('screenerPanel.v1', JSON.stringify({ selectedSavedId: 's1',
      lastScan: { ...SCAN, requestJson: undefined, [field]: request } }));
    vi.resetModules();
    vi.setSystemTime(NOW);
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().selectedSavedId).toBe('s1');
    expect(fresh.getState().lastScan).toBeNull();
  });
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useScreenerPanelStore.setState({
      selectedSavedId: null,
      lastScan: null,
      sortMode: 'default',
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

  it('새 조회 메타를 저장하면서 값이 같은 행은 재사용한다', () => {
    const store = useScreenerPanelStore.getState();
    store.setLastScan(SCAN);
    const previous = useScreenerPanelStore.getState().lastScan!;
    store.setLastScan({
      ...SCAN, rows: SCAN.rows.map((r) => ({ ...r })), scannedAtMs: NOW + 1000,
      hasMore: true, warnings: ['intraday_quote_invalid'],
    });
    const next = useScreenerPanelStore.getState().lastScan!;
    expect(next.rows).toBe(previous.rows);
    expect(next.scannedAtMs).toBe(NOW + 1000);
    expect(next.warnings).toEqual(['intraday_quote_invalid']);
    expect(JSON.parse(localStorage.getItem('screenerPanel.v1')!).lastScan.hasMore).toBe(true);

    store.setLastScan({ ...next, rows: [{ ...next.rows[0], trade_value_won: 200_000_000_000 }] });
    expect(useScreenerPanelStore.getState().lastScan!.rows[0].trade_value_won).toBe(200_000_000_000);
  });

  it('상한 여부를 새로고침 후에도 복원한다', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({ lastScan: { ...SCAN, hasMore: true } }));
    vi.resetModules();
    const restored = await import('./screenerPanel');
    expect(restored.useScreenerPanelStore.getState().lastScan?.hasMore).toBe(true);
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

    expect(fresh.getState().lastScan).toEqual({ ...SCAN, requestJson: undefined });
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

  it('classifies scan freshness by ttl', () => {
    expect(isPanelScanFresh(SCAN, NOW + SCREENER_PANEL_SCAN_TTL_MS)).toBe(true);
    expect(isPanelScanFresh(SCAN, NOW + SCREENER_PANEL_SCAN_TTL_MS + 1)).toBe(false);
    expect(isPanelScanFresh({ ...SCAN, scannedAtMs: NOW + 1 }, NOW)).toBe(false);
  });

  it('keeps a departed stock in place, updates matching quotes, and removes its shade on reentry', () => {
    const other = { ...SCAN.rows[0], code: '000660', name: 'SK하이닉스' };
    const store = useScreenerPanelStore.getState();
    store.setLastScan({ ...SCAN, rows: [...SCAN.rows, other] }, true);
    store.setLastScan({ ...SCAN, rows: [{ ...other, price: 180000 }], scannedAtMs: NOW + 1 }, true);
    const departed = useScreenerPanelStore.getState().lastScan!;
    expect(departed.rows.map(r => r.code)).toEqual(['005930', '000660']);
    expect(departed.exitedCodes).toEqual(['005930']);
    expect(departed.rows[1].price).toBe(180000);
    expect(departed.interactionStartedAtMs).toBe(NOW);
    store.setLastScan({ ...SCAN, rows: [other, { ...SCAN.rows[0], price: 71000 }] }, true);
    expect(useScreenerPanelStore.getState().lastScan).toMatchObject({
      exitedCodes: [], rows: [{ code: '005930', price: 71000 }, { code: '000660' }],
    });
  });

  it('bulk dismissal persists, does not resurrect absent stocks, and permits a new match', async () => {
    const store = useScreenerPanelStore.getState();
    store.setLastScan(SCAN, true);
    store.setLastScan({ ...SCAN, rows: [] }, true);
    store.dismissExited();
    expect(useScreenerPanelStore.getState().lastScan).toMatchObject({ rows: [], exitedCodes: [] });
    store.setLastScan({ ...SCAN, rows: [] }, true);
    expect(useScreenerPanelStore.getState().lastScan?.rows).toEqual([]);
    vi.resetModules();
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().lastScan).toMatchObject({ rows: [], exitedCodes: [] });
    fresh.getState().setLastScan(SCAN, true);
    expect(fresh.getState().lastScan).toMatchObject({ rows: SCAN.rows, exitedCodes: [] });
  });

  it('restores retained shaded rows and ignores corrupt exit codes', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({ lastScan: {
      ...SCAN, exitedCodes: ['005930', 'missing', 123],
    } }));
    vi.resetModules();
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().lastScan).toMatchObject({ rows: SCAN.rows, exitedCodes: ['005930'] });
  });

  it('uses the server position for newly matched stocks while retaining existing rows', () => {
    const other = { ...SCAN.rows[0], code: '000660', name: 'SK하이닉스' };
    const store = useScreenerPanelStore.getState();
    store.setLastScan({ ...SCAN, rows: [other] }, true);
    store.setLastScan({ ...SCAN, rows: [...SCAN.rows, other] }, true);
    expect(useScreenerPanelStore.getState().lastScan?.rows.map(row => row.code)).toEqual(['005930', '000660']);
  });

  it.each([
    { savedId: 'other' }, { savedUpdatedAtMs: 11 }, { basis: 'eod' as const },
    { requestJson: '{"conditions":[],"universe":{"markets":["KOSDAQ"]},"basis":"intraday"}' },
  ])('does not keep old rows when the search changes: %j', changes => {
    const store = useScreenerPanelStore.getState();
    store.setLastScan(SCAN, true);
    store.setLastScan({ ...SCAN, ...changes, rows: [] }, true);
    expect(useScreenerPanelStore.getState().lastScan?.rows).toEqual([]);
  });

  it('shares page/drawer request identities despite JSON property order', () => {
    const store = useScreenerPanelStore.getState();
    store.setLastScan(SCAN, true);
    store.setLastScan({ ...SCAN, rows: [], requestJson: '{"basis":"intraday","universe":{},"conditions":[]}' }, true);
    expect(useScreenerPanelStore.getState().lastScan?.exitedCodes).toEqual(['005930']);
  });

  it.each([
    { scanStatus: 'building' as const }, { hasMore: true }, { warnings: ['intraday_fallback_eod'] },
    { barCoverage: { total: 1, complete: 0, incomplete: [
      { code: '005930', condition_id: 'c', reason: 'recovering' },
    ] } },
    { dailyCoverage: { total: 1, complete: 0, incomplete: [
      { code: '005930', condition_id: 'c', reason: 'unverified' },
    ] } },
  ])('preserves an unevaluated stock without newly shading it: %j', changes => {
    const store = useScreenerPanelStore.getState();
    store.setLastScan(SCAN, true);
    store.setLastScan({ ...SCAN, ...changes, rows: [] }, true);
    expect(useScreenerPanelStore.getState().lastScan).toMatchObject({ rows: SCAN.rows, exitedCodes: [] });
  });

  it('shades evaluated departures even if another stock has insufficient history', () => {
    const store = useScreenerPanelStore.getState();
    store.setLastScan(SCAN, true);
    store.setLastScan({ ...SCAN, rows: [], warnings: ['bar_volume_partial'],
      barCoverage: { total: 2, complete: 1, incomplete: [{ code: '000660', condition_id: 'c', reason: 'preparing' }] },
    }, true);
    expect(useScreenerPanelStore.getState().lastScan?.exitedCodes).toEqual(['005930']);
  });

  it('explicit occurrence removal and a new monitoring run discard old rows immediately', () => {
    const store = useScreenerPanelStore.getState();
    store.setLastScan(SCAN, true);
    store.setLastScan({ ...SCAN, rows: [], dataStale: true });
    expect(useScreenerPanelStore.getState().lastScan?.rows).toEqual([]);
    store.setLastScan(SCAN, true);
    store.clearLastScan();
    store.setLastScan({ ...SCAN, rows: [] }, true);
    expect(useScreenerPanelStore.getState().lastScan?.rows).toEqual([]);
  });
});

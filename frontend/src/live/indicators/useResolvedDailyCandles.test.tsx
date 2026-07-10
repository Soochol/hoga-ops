import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLivePastDailyCandles } from '../../api/livePastDailyCandles';
import { useScreenerDailyCandles } from '../../api/screenerDailyCandles';
import { LIVE_SETTINGS_KEY, type LiveSettings } from '../../api/liveSettings';
import { useResolvedDailyCandles } from './useResolvedDailyCandles';

vi.mock('../../api/livePastDailyCandles', () => ({ useLivePastDailyCandles: vi.fn() }));
vi.mock('../../api/screenerDailyCandles', () => ({ useScreenerDailyCandles: vi.fn() }));

const mockUseKisDaily = vi.mocked(useLivePastDailyCandles);
const mockUseScreenerDaily = vi.mocked(useScreenerDailyCandles);

function makeWrapper(bypass = false) {
  return function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(LIVE_SETTINGS_KEY, {
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: bypass,
      heatmap_capture_enabled: true,
    } satisfies LiveSettings);
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const wrapper = makeWrapper(false);

const D1 = 1_781_568_000_000; // 2026-06-16 09:00 KST
const D2 = 1_781_654_400_000; // 2026-06-17 09:00 KST

function kisRow(t_ms: number, close: number) {
  return { t_ms, open: close - 1, high: close + 1, low: close - 2, close, volume: 100 };
}

function screenerRow(t_ms: number, close: number) {
  return { t_ms, open: close - 1, high: close + 1, low: close - 2, close, volume: 200 };
}

describe('useResolvedDailyCandles', () => {
  beforeEach(() => {
    mockUseKisDaily.mockReturnValue({
      data: { candles: [], data_warnings: [], code: '005930', from: '20260616', to: '20260617' },
      isLoading: false,
      error: null,
    } as never);
    mockUseScreenerDaily.mockReturnValue({
      data: { candles: [], data_warnings: [], code: '005930', from: '20260616', to: '20260617', source: 'screener_daily' },
      isLoading: false,
      error: null,
    } as never);
  });

  it('requests KIS daily and screener daily in parallel when enabled', () => {
    renderHook(
      () =>
        useResolvedDailyCandles({
          code: '005930',
          from: '20260616',
          to: '20260617',
          venue: 'UN',
          enabled: true,
        }),
      { wrapper },
    );

    expect(mockUseKisDaily).toHaveBeenCalledWith('005930', '20260616', '20260617', 'UN');
    expect(mockUseScreenerDaily).toHaveBeenCalledWith('005930', '20260616', '20260617');
  });

  it('disables both adapters when input is disabled', () => {
    renderHook(
      () =>
        useResolvedDailyCandles({
          code: '005930',
          from: '20260616',
          to: '20260617',
          venue: 'KRX',
          enabled: false,
        }),
      { wrapper },
    );

    expect(mockUseKisDaily).toHaveBeenCalledWith(null, null, null, 'KRX');
    expect(mockUseScreenerDaily).toHaveBeenCalledWith(null, null, null);
  });

  it('disables the KIS adapter when KIS API bypass is ON, even with kisEnabled default true', () => {
    mockUseScreenerDaily.mockReturnValue({
      data: {
        candles: [screenerRow(D1, 100)],
        data_warnings: [],
        code: '005930',
        from: '20260616',
        to: '20260617',
        source: 'screener_daily',
      },
      isLoading: false,
      error: null,
    } as never);

    const { result } = renderHook(
      () =>
        useResolvedDailyCandles({
          code: '005930',
          from: '20260616',
          to: '20260617',
          venue: 'KRX',
          enabled: true,
        }),
      { wrapper: makeWrapper(true) },
    );

    // 우회 ON: /live 캔들이 스크리너로 전환되므로 일봉 MA도 KIS를 끈다(code=null).
    expect(mockUseKisDaily).toHaveBeenCalledWith(null, null, null, 'KRX');
    expect(result.current.candles.map((c) => c.close)).toEqual([100]);
    expect(result.current.sourceByDate.get('20260616')).toBe('screener_daily');
  });

  it('disables the KIS adapter (screener-only) when kisEnabled is false', () => {
    mockUseScreenerDaily.mockReturnValue({
      data: {
        candles: [screenerRow(D1, 100), screenerRow(D2, 110)],
        data_warnings: [],
        code: '005930',
        from: '20260616',
        to: '20260617',
        source: 'screener_daily',
      },
      isLoading: false,
      error: null,
    } as never);

    const { result } = renderHook(
      () =>
        useResolvedDailyCandles({
          code: '005930',
          from: '20260616',
          to: '20260617',
          venue: 'KRX',
          enabled: true,
          kisEnabled: false,
        }),
      { wrapper },
    );

    // KIS 훅은 code null로 비활성화되고, 스크리너 단독으로 렌더된다(/study 디스크 온리).
    expect(mockUseKisDaily).toHaveBeenCalledWith(null, null, null, 'KRX');
    expect(mockUseScreenerDaily).toHaveBeenCalledWith('005930', '20260616', '20260617');
    expect(result.current.candles.map((c) => c.close)).toEqual([100, 110]);
    expect(result.current.sourceByDate.get('20260616')).toBe('screener_daily');
  });

  it('uses screener daily rows when KIS daily is empty with kis_rest_bypassed', () => {
    mockUseKisDaily.mockReturnValue({
      data: {
        candles: [],
        data_warnings: [{ batch: '20260616__20260617', reason: 'kis_rest_bypassed', msg: 'cache only' }],
        code: '005930',
        from: '20260616',
        to: '20260617',
      },
      isLoading: false,
      error: null,
    } as never);
    mockUseScreenerDaily.mockReturnValue({
      data: {
        candles: [screenerRow(D1, 100), screenerRow(D2, 110)],
        data_warnings: [],
        code: '005930',
        from: '20260616',
        to: '20260617',
        source: 'screener_daily',
      },
      isLoading: false,
      error: null,
    } as never);

    const { result } = renderHook(
      () =>
        useResolvedDailyCandles({
          code: '005930',
          from: '20260616',
          to: '20260617',
          venue: 'KRX',
          enabled: true,
        }),
      { wrapper },
    );

    expect(result.current.candles.map((c) => c.close)).toEqual([100, 110]);
    expect(result.current.sourceByDate.get('20260616')).toBe('screener_daily');
    expect(result.current.dataWarnings).toHaveLength(1);
  });

  it('keeps KIS daily for dates where both adapters return rows', () => {
    mockUseKisDaily.mockReturnValue({
      data: { candles: [kisRow(D1, 101)], data_warnings: [], code: '005930', from: '20260616', to: '20260617' },
      isLoading: false,
      error: null,
    } as never);
    mockUseScreenerDaily.mockReturnValue({
      data: {
        candles: [screenerRow(D1, 100), screenerRow(D2, 110)],
        data_warnings: [],
        code: '005930',
        from: '20260616',
        to: '20260617',
        source: 'screener_daily',
      },
      isLoading: false,
      error: null,
    } as never);

    const { result } = renderHook(
      () =>
        useResolvedDailyCandles({
          code: '005930',
          from: '20260616',
          to: '20260617',
          venue: 'KRX',
          enabled: true,
        }),
      { wrapper },
    );

    expect(result.current.candles.map((c) => c.close)).toEqual([101, 110]);
    expect(result.current.sourceByDate.get('20260616')).toBe('kis_daily');
    expect(result.current.sourceByDate.get('20260617')).toBe('screener_daily');
  });

  it('is usable as soon as either adapter has data', () => {
    mockUseKisDaily.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as never);
    mockUseScreenerDaily.mockReturnValue({
      data: {
        candles: [screenerRow(D1, 100)],
        data_warnings: [],
        code: '005930',
        from: '20260616',
        to: '20260617',
        source: 'screener_daily',
      },
      isLoading: false,
      error: null,
    } as never);

    const { result } = renderHook(
      () =>
        useResolvedDailyCandles({
          code: '005930',
          from: '20260616',
          to: '20260617',
          venue: 'KRX',
          enabled: true,
        }),
      { wrapper },
    );

    expect(result.current.candles).toHaveLength(1);
    expect(result.current.isLoading).toBe(false);
  });
});

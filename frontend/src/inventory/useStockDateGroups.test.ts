import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStockDateGroups } from './useStockDateGroups';
import type { StockDate } from '../api/types';

const row = (code: string, name: string, date: string, capturedAt: number, sizeBytes: number): StockDate => ({
  date, code, name,
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0,
  captured_at: capturedAt,
  total_volume: 0, pages_collected: 0, file_size_bytes: sizeBytes,
  today_open: 0, today_high: 0, today_low: 0, today_close: 0,
  disk_state: 'complete',
  full_capture_count: null,
  fail_streak: 0,
  blocked: false,
});

describe('useStockDateGroups', () => {
  const rows: StockDate[] = [
    row('005930', '삼성전자', '20260520', 1_000, 12_700_000),
    row('005930', '삼성전자', '20260522', 3_000, 13_200_000),
    row('005930', '삼성전자', '20260521', 2_000, 12_800_000),
    row('000660', 'SK하이닉스', '20260521', 4_000, 11_400_000),
    row('035720', '카카오',     '20260522', 5_000, 4_700_000),
  ];

  it('groups by code', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, ''));
    expect(result.current).toHaveLength(3);
    const samsung = result.current.find(g => g.code === '005930')!;
    expect(samsung.dates).toHaveLength(3);
  });

  it('sorts children dates desc', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, ''));
    const samsung = result.current.find(g => g.code === '005930')!;
    expect(samsung.dates.map(d => d.date)).toEqual(['20260522', '20260521', '20260520']);
  });

  it('aggregates lastCapturedAt = max(captured_at) and totalSizeBytes = sum', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, ''));
    const samsung = result.current.find(g => g.code === '005930')!;
    expect(samsung.lastCapturedAt).toBe(3_000);
    expect(samsung.totalSizeBytes).toBe(12_700_000 + 13_200_000 + 12_800_000);
  });

  it('sorts parent groups by lastCapturedAt desc', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, ''));
    expect(result.current.map(g => g.code)).toEqual(['035720', '000660', '005930']);
  });

  it('search by name (한글 부분 매칭)', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, '삼성'));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].code).toBe('005930');
  });

  it('search by code (prefix)', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, '0059'));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].code).toBe('005930');
  });

  it('search is case-insensitive and trimmed', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, '  삼성  '));
    expect(result.current).toHaveLength(1);
  });

  it('empty search returns all groups', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, ''));
    expect(result.current).toHaveLength(3);
  });

  it('no match returns empty array', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, 'NOMATCH_XYZ'));
    expect(result.current).toHaveLength(0);
  });

  it('empty rows returns empty array', () => {
    const { result } = renderHook(() => useStockDateGroups([], ''));
    expect(result.current).toEqual([]);
  });
});

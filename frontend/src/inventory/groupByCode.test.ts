import { describe, expect, it } from 'vitest';
import { groupStockDatesByCode } from './groupByCode';
import type { StockDate } from '../api/types';

const row = (
  code: string,
  name: string,
  date: string,
  capturedAt: number,
  sizeBytes: number,
): StockDate => ({
  date, code, name,
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0,
  captured_at: capturedAt,
  total_volume: 0, pages_collected: 0, file_size_bytes: sizeBytes,
  today_open: 0, today_high: 0, today_low: 0, today_close: 0,
  disk_state: 'complete',
});

describe('groupStockDatesByCode', () => {
  const rows: StockDate[] = [
    row('005930', '삼성전자', '20260520', 1_000, 12_700_000),
    row('005930', '삼성전자', '20260522', 3_000, 13_200_000),
    row('000660', 'SK하이닉스', '20260521', 4_000, 11_400_000),
    row('005930', '삼성전자', '20260521', 2_000, 12_800_000),
  ];

  it('groups by code', () => {
    const groups = groupStockDatesByCode(rows);
    expect(groups).toHaveLength(2);
    const samsung = groups.find((g) => g.code === '005930')!;
    expect(samsung.dates).toHaveLength(3);
  });

  it('preserves insertion order (first-seen Code first)', () => {
    const groups = groupStockDatesByCode(rows);
    expect(groups.map((g) => g.code)).toEqual(['005930', '000660']);
  });

  it('preserves original date order within a group (no sorting)', () => {
    const groups = groupStockDatesByCode(rows);
    const samsung = groups.find((g) => g.code === '005930')!;
    expect(samsung.dates.map((d) => d.date)).toEqual(['20260520', '20260522', '20260521']);
  });

  it('aggregates lastCapturedAt = max(captured_at)', () => {
    const groups = groupStockDatesByCode(rows);
    expect(groups.find((g) => g.code === '005930')!.lastCapturedAt).toBe(3_000);
    expect(groups.find((g) => g.code === '000660')!.lastCapturedAt).toBe(4_000);
  });

  it('aggregates totalSizeBytes = sum(file_size_bytes)', () => {
    const groups = groupStockDatesByCode(rows);
    expect(groups.find((g) => g.code === '005930')!.totalSizeBytes).toBe(
      12_700_000 + 13_200_000 + 12_800_000,
    );
  });

  it('borrows name from the first row of each Code', () => {
    const groups = groupStockDatesByCode(rows);
    expect(groups.find((g) => g.code === '005930')!.name).toBe('삼성전자');
  });

  it('returns empty array for empty rows', () => {
    expect(groupStockDatesByCode([])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRecaptureSelection } from './useRecaptureSelection';
import type { StockDate } from '../api/types';

const row = (date: string, disk_state: StockDate['disk_state'] = 'complete'): StockDate => ({
  date, code: '005930', name: '삼성전자',
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0, captured_at: 1000,
  total_volume: 0, pages_collected: 0, file_size_bytes: 0,
  today_open: 0, today_high: 0, today_low: 0, today_close: 0,
  disk_state,
});

describe('useRecaptureSelection', () => {
  it('derives recapturableDates from non-complete rows', () => {
    const rows = [row('20260520', 'source_partial'), row('20260521', 'complete'), row('20260522', 'invalid')];
    const { result } = renderHook(() => useRecaptureSelection(rows, '005930'));
    expect([...result.current.recapturableDates].sort()).toEqual(['20260520', '20260522']);
  });

  it('toggleSelection adds and removes dates', () => {
    const rows = [row('20260520', 'source_partial'), row('20260521', 'client_incomplete')];
    const { result } = renderHook(() => useRecaptureSelection(rows, '005930'));
    act(() => { result.current.toggleSelection('20260520'); });
    expect(result.current.selectedDates.has('20260520')).toBe(true);
    act(() => { result.current.toggleSelection('20260520'); });
    expect(result.current.selectedDates.has('20260520')).toBe(false);
  });

  it('clearSelection empties the set', () => {
    const rows = [row('20260520', 'source_partial')];
    const { result } = renderHook(() => useRecaptureSelection(rows, '005930'));
    act(() => { result.current.toggleSelection('20260520'); });
    expect(result.current.selectedDates.size).toBe(1);
    act(() => { result.current.clearSelection(); });
    expect(result.current.selectedDates.size).toBe(0);
  });

  it('clears selection when selectedCode changes', () => {
    const rows = [row('20260520', 'source_partial')];
    const { result, rerender } = renderHook(
      ({ code }: { code: string }) => useRecaptureSelection(rows, code),
      { initialProps: { code: '005930' } },
    );
    act(() => { result.current.toggleSelection('20260520'); });
    expect(result.current.selectedDates.size).toBe(1);
    rerender({ code: '000660' });
    expect(result.current.selectedDates.size).toBe(0);
  });

  it('prunes selected dates whose row flipped to complete', () => {
    const initial = [row('20260520', 'source_partial')];
    const { result, rerender } = renderHook(
      ({ rs }: { rs: StockDate[] }) => useRecaptureSelection(rs, '005930'),
      { initialProps: { rs: initial } },
    );
    act(() => { result.current.toggleSelection('20260520'); });
    expect(result.current.selectedDates.has('20260520')).toBe(true);

    rerender({ rs: [row('20260520', 'complete')] });
    expect(result.current.selectedDates.has('20260520')).toBe(false);
  });

  it('prunes selected dates whose row was removed', () => {
    const initial = [row('20260520', 'source_partial'), row('20260521', 'invalid')];
    const { result, rerender } = renderHook(
      ({ rs }: { rs: StockDate[] }) => useRecaptureSelection(rs, '005930'),
      { initialProps: { rs: initial } },
    );
    act(() => {
      result.current.toggleSelection('20260520');
      result.current.toggleSelection('20260521');
    });
    expect(result.current.selectedDates.size).toBe(2);

    rerender({ rs: [row('20260521', 'invalid')] });
    expect(result.current.selectedDates.has('20260520')).toBe(false);
    expect(result.current.selectedDates.has('20260521')).toBe(true);
  });
});

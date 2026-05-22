import { describe, expect, it, vi, beforeEach } from 'vitest';
import { reconcileCalendar, applyCellPatch, type EnrichedCell } from './useCalendar';

beforeEach(() => { vi.restoreAllMocks(); });

const baseCell = (date: string, status: 'complete' | 'source_partial' | 'none' = 'complete', captured_at_ms: number | null = 1): EnrichedCell => ({
  date, status, captured_at_ms,
});

describe('reconcileCalendar (Q21)', () => {
  it('returns incoming cells when no prior cache exists', () => {
    const incoming = { cells: [baseCell('20260518')], as_of_ms: 1_700_000_000_500 };
    const merged = reconcileCalendar(undefined, incoming);
    expect(merged.cells).toEqual(incoming.cells);
    expect(merged.as_of_ms).toBe(incoming.as_of_ms);
  });

  it('keeps a prior cell when patched_at_ms > incoming.as_of_ms (SSE-newer)', () => {
    const prior = {
      cells: [{ ...baseCell('20260518'), status: 'source_partial' as const, patched_at_ms: 1_700_000_001_000 }],
      as_of_ms: 1_700_000_000_000,
    };
    const incoming = { cells: [baseCell('20260518', 'complete')], as_of_ms: 1_700_000_000_500 };
    const merged = reconcileCalendar(prior, incoming);
    expect(merged.cells[0].status).toBe('source_partial');
    expect(merged.cells[0].patched_at_ms).toBe(1_700_000_001_000);
    expect(merged.as_of_ms).toBe(incoming.as_of_ms);
  });

  it('takes incoming when patched_at_ms <= incoming.as_of_ms (GET-newer)', () => {
    const prior = {
      cells: [{ ...baseCell('20260518'), patched_at_ms: 1_700_000_000_100 }],
      as_of_ms: 1_700_000_000_000,
    };
    const incoming = { cells: [baseCell('20260518', 'source_partial')], as_of_ms: 1_700_000_000_500 };
    const merged = reconcileCalendar(prior, incoming);
    expect(merged.cells[0].status).toBe('source_partial');
    expect(merged.cells[0].patched_at_ms).toBeUndefined();
  });

  it('handles cells present in only one side (incoming wins by default)', () => {
    const prior = { cells: [baseCell('20260518')], as_of_ms: 1 };
    const incoming = { cells: [baseCell('20260519')], as_of_ms: 2 };
    const merged = reconcileCalendar(prior, incoming);
    expect(merged.cells.map((c) => c.date)).toEqual(['20260519']);
  });
});

describe('applyCellPatch', () => {
  it('updates the matching date and stamps patched_at_ms', () => {
    const prior = { cells: [baseCell('20260518', 'none')], as_of_ms: 0 };
    const next = applyCellPatch(prior, '20260518', { status: 'complete', captured_at_ms: 42 }, 999);
    expect(next.cells[0].status).toBe('complete');
    expect(next.cells[0].patched_at_ms).toBe(999);
  });

  it('returns prior unchanged when date not in cells', () => {
    const prior = { cells: [baseCell('20260518')], as_of_ms: 0 };
    const next = applyCellPatch(prior, '20260520', { status: 'complete' }, 999);
    expect(next).toBe(prior);
  });
});

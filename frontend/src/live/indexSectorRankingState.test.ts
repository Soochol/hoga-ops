import { describe, it, expect } from 'vitest';
import {
  initialIndexSectorRankingUiState,
  reduceIndexSectorRankingState,
  resolveActiveSectorId,
  resolveBasisDate,
} from './indexSectorRankingState';
import type { IndexSectorRankingSector } from '../api/indexSectorRankings';

const sectors: IndexSectorRankingSector[] = [
  { folder_id: 'semi', folder_name: '반도체', order: 0, change_pct: 5, finite_count: 1, total_count: 1, stocks: [] },
  { folder_id: 'bio', folder_name: '바이오', order: 1, change_pct: 3, finite_count: 1, total_count: 1, stocks: [] },
];

describe('index sector ranking state', () => {
  it('uses latest date until hover sets a basis', () => {
    const state = initialIndexSectorRankingUiState;
    expect(resolveBasisDate(state, '20260619')).toEqual({ date: '20260619', mode: 'latest' });

    const hovered = reduceIndexSectorRankingState(state, { type: 'hover_date', date: '20260618' });
    expect(resolveBasisDate(hovered, '20260619')).toEqual({ date: '20260618', mode: 'hover' });
  });

  it('clicking a date pins it and ignores later hover changes', () => {
    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_date_pin',
      date: '20260618',
    });
    const hovered = reduceIndexSectorRankingState(pinned, { type: 'hover_date', date: '20260619' });

    expect(resolveBasisDate(hovered, '20260620')).toEqual({ date: '20260618', mode: 'pinned' });
  });

  it('clicking the pinned date again clears the pin', () => {
    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_date_pin',
      date: '20260618',
    });
    const unpinned = reduceIndexSectorRankingState(pinned, {
      type: 'toggle_date_pin',
      date: '20260618',
    });

    expect(resolveBasisDate(unpinned, '20260619')).toEqual({ date: '20260619', mode: 'latest' });
  });

  it('clears stale hover date when an explicit pin clear happens after leaving the candle', () => {
    const hovered = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'hover_date',
      date: '20260618',
    });
    const pinned = reduceIndexSectorRankingState(hovered, {
      type: 'toggle_date_pin',
      date: '20260618',
    });
    const leftChart = reduceIndexSectorRankingState(pinned, {
      type: 'hover_date',
      date: null,
    });
    const unpinned = reduceIndexSectorRankingState(leftChart, {
      type: 'clear_date_pin',
    });

    expect(resolveBasisDate(unpinned, '20260619')).toEqual({ date: '20260619', mode: 'latest' });
  });

  it('sector hover previews without overwriting a pinned sector', () => {
    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_sector_pin',
      sectorKey: 'folder:semi',
    });
    const preview = reduceIndexSectorRankingState(pinned, {
      type: 'preview_sector',
      sectorKey: 'folder:bio',
    });

    expect(resolveActiveSectorId(sectors, preview)).toBe('bio');

    const ended = reduceIndexSectorRankingState(preview, { type: 'preview_sector', sectorKey: null });
    expect(resolveActiveSectorId(sectors, ended)).toBe('semi');
  });

  it('sector click toggles pin and falls back to rank 1', () => {
    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_sector_pin',
      sectorKey: 'folder:bio',
    });
    expect(resolveActiveSectorId(sectors, pinned)).toBe('bio');

    const unpinned = reduceIndexSectorRankingState(pinned, {
      type: 'toggle_sector_pin',
      sectorKey: 'folder:bio',
    });
    expect(resolveActiveSectorId(sectors, unpinned)).toBe('semi');
  });

  it('keeps uncategorized sectors addressable when previewing and pinning', () => {
    const uncategorizedSectors: IndexSectorRankingSector[] = [
      {
        folder_id: 'semi',
        folder_name: '반도체',
        order: 0,
        change_pct: 5,
        finite_count: 1,
        total_count: 1,
        stocks: [],
      },
      {
        folder_id: null,
        folder_name: '미분류',
        order: 1,
        change_pct: 2,
        finite_count: 1,
        total_count: 1,
        stocks: [],
      },
    ];

    const previewed = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'preview_sector',
      sectorKey: '__uncat__',
    });
    expect(resolveActiveSectorId(uncategorizedSectors, previewed)).toBeNull();

    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_sector_pin',
      sectorKey: '__uncat__',
    });
    expect(resolveActiveSectorId(uncategorizedSectors, pinned)).toBeNull();

    const unpinned = reduceIndexSectorRankingState(pinned, {
      type: 'toggle_sector_pin',
      sectorKey: '__uncat__',
    });
    expect(resolveActiveSectorId(uncategorizedSectors, unpinned)).toBe('semi');
  });

  it('clears missing pinned sector and falls back to rank 1', () => {
    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_sector_pin',
      sectorKey: 'folder:removed',
    });

    expect(resolveActiveSectorId(sectors, pinned)).toBe('semi');
  });
});

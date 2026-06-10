import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { HeatmapFolder } from './HeatmapFolder';
import type { WatchlistEntry, WatchlistFolder } from '../api/watchlist';
import type { LiveQuote } from '../api/liveQuotes';

const folder: WatchlistFolder = { id: 'f1', name: '반도체', order: 0 };
const E = (code: string, name: string, order: number): WatchlistEntry => ({
  code, name, registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f1', order,
});
const entries = [E('005930', '삼성전자', 0), E('000660', 'SK하이닉스', 1)];
const quotes = new Map<string, LiveQuote>([
  ['005930', { code: '005930', price: 70000, change_pct: 2, change_won: 1400 }],
  ['000660', { code: '000660', price: 200000, change_pct: 8, change_won: 16000 }],
]);

it('폴더명 + 평균 등락률 표시, change 모드는 등락률 내림차순', () => {
  render(<HeatmapFolder folder={folder} entries={entries} quoteByCode={quotes}
    sortMode="change" onPick={() => {}} />);
  expect(screen.getByText('반도체')).toBeInTheDocument();
  expect(screen.getByText('+5.0%')).toBeInTheDocument(); // (2+8)/2
  const names = screen.getAllByText(/삼성전자|SK하이닉스/).map((n) => n.textContent);
  expect(names).toEqual(['SK하이닉스', '삼성전자']); // 8% 먼저
});

it('행 클릭 시 onPick(code)', () => {
  const onPick = vi.fn();
  render(<HeatmapFolder folder={folder} entries={entries} quoteByCode={quotes}
    sortMode="manual" onPick={onPick} />);
  fireEvent.click(screen.getByTestId('heatmap-row-005930'));
  expect(onPick).toHaveBeenCalledWith('005930');
});

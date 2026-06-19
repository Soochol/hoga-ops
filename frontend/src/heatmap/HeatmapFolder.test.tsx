import { vi } from 'vitest';
vi.mock('./FolderAddButton', () => ({ FolderAddButton: () => null }));
import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect } from 'vitest';
import { HeatmapFolder } from './HeatmapFolder';
import { heatHeaderBg } from './heat';
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
  const avgEl = screen.getByText('+5.0%');
  expect(avgEl).toHaveClass('text-fg-dim');                       // G4: 흐린 텍스트
  expect(avgEl.getAttribute('style') ?? '').not.toMatch(/background/); // 칩 배경 제거
  const names = screen.getAllByText(/삼성전자|SK하이닉스/).map((n) => n.textContent);
  expect(names).toEqual(['SK하이닉스', '삼성전자']); // 8% 먼저
});

it('행 클릭 시 onPick(code, name, current-tab) — 종목명을 탭 라벨로 전달', () => {
  const onPick = vi.fn();
  render(<HeatmapFolder folder={folder} entries={entries} quoteByCode={quotes}
    sortMode="manual" onPick={onPick} />);
  fireEvent.click(screen.getByTestId('heatmap-row-005930'));
  expect(onPick).toHaveBeenCalledWith('005930', '삼성전자', { disposition: 'current-tab' });
});

it('미분류(folder=null) 헤더도 자체 평균 틴트(무분기, G8)', () => {
  const uncatEntries = [E('111111', '에이', 0), E('222222', '비이', 1)];
  const uncatQuotes = new Map<string, LiveQuote>([
    ['111111', { code: '111111', price: 1000, change_pct: -2, change_won: -20 }],
    ['222222', { code: '222222', price: 2000, change_pct: -4, change_won: -80 }],
  ]);
  render(<HeatmapFolder folder={null} entries={uncatEntries} quoteByCode={uncatQuotes}
    sortMode="manual" onPick={() => {}} />);
  const header = screen.getByText('미분류').parentElement as HTMLElement;
  expect(header.style.background).toBe(heatHeaderBg(-3)); // (−2−4)/2
});

it('평면 보드(L3-B) 좌측 스파인 + 헤더 평균 틴트(#3): 폴더는 카드 대신 좌측 스파인, 헤더는 평균 등락 비례 배경', () => {
  const { container } = render(
    <HeatmapFolder folder={folder} entries={entries} quoteByCode={quotes}
      sortMode="change" onPick={() => {}} />,
  );
  // L3-B: 폴더 루트 — 카드 배경·외곽 테두리 제거, 좌측 중립 스파인
  const root = container.querySelector('#heatmap-folder-f1') as HTMLElement;
  expect(root).toBeInTheDocument();
  expect(root).toHaveClass('border-l-2', 'border-border-strong');
  expect(root).not.toHaveClass('bg-bg-card');
  expect(root).not.toHaveClass('border-border'); // 외곽 박스 테두리 제거
  // 헤더 밴드 = 폴더명 span 의 부모 div
  const header = screen.getByText('반도체').parentElement as HTMLElement;
  // #3/G4: 헤더 밴드 = 평균(+5%) 비례 히트 틴트. bg-input 클래스 제거, inline background.
  expect(header).not.toHaveClass('bg-bg-input');
  expect(header.style.background).toBe(heatHeaderBg(5)); // (2+8)/2 = +5%
});

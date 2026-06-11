import { vi } from 'vitest';
vi.mock('./FolderAddButton', () => ({ FolderAddButton: () => null }));
import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect } from 'vitest';
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

it('행 클릭 시 onPick(code, name) — 종목명을 탭 라벨로 전달', () => {
  const onPick = vi.fn();
  render(<HeatmapFolder folder={folder} entries={entries} quoteByCode={quotes}
    sortMode="manual" onPick={onPick} />);
  fireEvent.click(screen.getByTestId('heatmap-row-005930'));
  expect(onPick).toHaveBeenCalledWith('005930', '삼성전자');
});

it('평면 보드(L3-B)+헤더 틴트 없음(L1): 폴더는 카드 대신 좌측 스파인, 헤더는 bg-input·틴트 없음', () => {
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
  // L3-B: 헤더를 폴더 본문보다 한 단계 밝게(그룹 앵커)
  expect(header).toHaveClass('bg-bg-input');
  expect(header).not.toHaveClass('bg-bg-subtle');
  // L1: 헤더 히트 틴트(box-shadow) 없음 — 평균 +5%여도 배경 워시 없음
  expect(header.style.boxShadow).toBe('');
});

import { vi } from 'vitest';
vi.mock('./FolderAddButton', () => ({ FolderAddButton: () => null }));
import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { HeatmapBoard } from './HeatmapBoard';
import type { LiveQuote } from '../api/liveQuotes';
import type { HeatmapGroup } from './heat';

const groups: HeatmapGroup[] = [
  { folder: { id: 'f1', name: '반도체', order: 0 }, entries: [
    { code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 }] },
  { folder: { id: 'f2', name: '빈폴더', order: 1 }, entries: [] },     // 빈 → 헤더+안내만
  { folder: { id: 'f3', name: '대형주', order: 2 }, entries: [
    { code: '000660', name: 'SK하이닉스', folder_id: 'f3', order: 0 }] },
];

// 빈 폴더를 숨기면 종목을 넣는 표면(헤더 ＋종목·그룹 드롭존)이 통째로 사라져 갓 만든
// 그룹이 데드엔드가 된다 — 그래서 보드는 빈 폴더도 렌더한다(드로어와 대칭).
it('빈 폴더도 헤더와 안내를 렌더한다', () => {
  render(<HeatmapBoard groups={groups} quoteByCode={new Map<string, LiveQuote>()}
    sortMode="desc" onPick={() => {}} />);
  expect(screen.getByText('반도체')).toBeInTheDocument();
  expect(screen.getByText('빈폴더')).toBeInTheDocument();
  expect(screen.getByTestId('heatmap-folder-empty')).toBeInTheDocument();
  expect(document.getElementById('heatmap-folder-f2')).toBeTruthy();  // 드롭·스크롤 대상
  expect(screen.getByText('대형주')).toBeInTheDocument();
  expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
});

it('폴더 카드에 스크롤 앵커 id가 있다(스트립 점프 대상)', () => {
  render(<HeatmapBoard groups={groups} quoteByCode={new Map<string, LiveQuote>()}
    sortMode="desc" onPick={() => {}} />);
  expect(document.getElementById('heatmap-folder-f1')).toBeTruthy();
});

it('quote 의 OHLC 로 행에 캔들이 그려진다(양봉=적)', () => {
  const qbc = new Map<string, LiveQuote>([
    ['005930', { code: '005930', price: 115, change_pct: 1, change_won: 7,
                 open: 100, high: 120, low: 95 }],  // close=115>open=100 → 양봉
  ]);
  render(<HeatmapBoard groups={groups} quoteByCode={qbc}
    sortMode="desc" onPick={() => {}} />);
  expect(document.querySelector('.candle-glyph rect:last-child')?.getAttribute('fill'))
    .toBe('var(--price-up)');
});

import { vi } from 'vitest';
vi.mock('./FolderAddButton', () => ({ FolderAddButton: () => null }));
import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { HeatmapBoard } from './HeatmapBoard';
import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';
import type { HeatmapEntry } from '../api/heatmap';

const groups: FolderGroup<HeatmapEntry>[] = [
  { folder: { id: 'f1', name: '반도체', order: 0 }, entries: [
    { code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 }] },
  { folder: { id: 'f2', name: '빈폴더', order: 1 }, entries: [] },     // 빈 → 제외
  { folder: null, entries: [                                            // 비어있지 않은 미분류 → 포함(ADR-0068 G3)
    { code: '000660', name: 'SK하이닉스', folder_id: null, order: 0 }] },
];

it('빈 폴더는 제외, 비어있지 않은 미분류는 포함(별도 그룹)', () => {
  render(<HeatmapBoard groups={groups} quoteByCode={new Map<string, LiveQuote>()}
    sortMode="desc" onPick={() => {}} />);
  expect(screen.getByText('반도체')).toBeInTheDocument();
  expect(screen.queryByText('빈폴더')).not.toBeInTheDocument();
  // ADR-0068 G3: 미분류 그룹이 '미분류' 라벨로 표시되고 소속 종목이 보인다
  // (분리 후 새로 추가한 종목은 항상 미분류로 먼저 들어가므로 숨기면 안 됨).
  expect(screen.getByText('미분류')).toBeInTheDocument();
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

import { vi } from 'vitest';
vi.mock('./FolderAddButton', () => ({ FolderAddButton: () => null }));
import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { HeatmapBoard } from './HeatmapBoard';
import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';

const groups: FolderGroup[] = [
  { folder: { id: 'f1', name: '반도체', order: 0 }, entries: [
    { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f1', order: 0 }] },
  { folder: { id: 'f2', name: '빈폴더', order: 1 }, entries: [] },     // 빈 → 제외
  { folder: null, entries: [                                            // 미분류 → 제외
    { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 }] },
];

it('빈 폴더와 미분류는 보드에서 제외', () => {
  render(<HeatmapBoard groups={groups} quoteByCode={new Map<string, LiveQuote>()}
    sortMode="change" onPick={() => {}} />);
  expect(screen.getByText('반도체')).toBeInTheDocument();
  expect(screen.queryByText('빈폴더')).not.toBeInTheDocument();
  expect(screen.queryByText('SK하이닉스')).not.toBeInTheDocument();
});

import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { SectorTempStrip } from './SectorTempStrip';
import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';

const entry = (code: string, folderId: string | null, order = 0) => ({
  code, name: code, registered_at_kst_date: '20260101',
  last_success_date: null, folder_id: folderId, order,
});

const groups: FolderGroup[] = [
  { folder: { id: 'f1', name: '반도체', order: 0 }, entries: [entry('005930', 'f1')] }, // +1
  { folder: { id: 'f2', name: '로봇', order: 1 }, entries: [entry('111', 'f2')] },       // +4
  { folder: { id: 'f3', name: '통신', order: 2 }, entries: [entry('222', 'f3')] },       // -2
  { folder: { id: 'f4', name: '빈폴더', order: 3 }, entries: [] },                        // 제외(빈)
  { folder: { id: 'f5', name: '결측', order: 4 }, entries: [entry('333', 'f5')] },       // 제외(avg null)
];
const quoteByCode = new Map<string, LiveQuote>([
  ['005930', { code: '005930', price: 1, change_pct: 1, change_won: 0 }],
  ['111', { code: '111', price: 1, change_pct: 4, change_won: 0 }],
  ['222', { code: '222', price: 1, change_pct: -2, change_won: 0 }],
  // 333 없음 → 결측 섹터 avg null
]);

it('가시 섹터를 뜨거운 순(avg 내림차순)으로, 빈/결측 섹터는 제외', () => {
  render(<SectorTempStrip groups={groups} quoteByCode={quoteByCode} onJump={() => {}} />);
  const chips = screen.getAllByRole('button').map((c) => c.textContent ?? '');
  expect(chips.length).toBe(3);
  expect(chips[0]).toMatch(/로봇/);   // +4
  expect(chips[1]).toMatch(/반도체/); // +1
  expect(chips[2]).toMatch(/통신/);   // -2
});

it('칩 클릭 → onJump(folderId)', () => {
  const onJump = vi.fn();
  render(<SectorTempStrip groups={groups} quoteByCode={quoteByCode} onJump={onJump} />);
  fireEvent.click(screen.getAllByRole('button')[0]); // 로봇 = f2
  expect(onJump).toHaveBeenCalledWith('f2');
});

it('상승 칩 배경 = 적(--price-up rgb), 하락 칩 = 청', () => {
  render(<SectorTempStrip groups={groups} quoteByCode={quoteByCode} onJump={() => {}} />);
  const up = screen.getAllByRole('button')[0];   // 로봇 +4
  const down = screen.getAllByRole('button')[2]; // 통신 -2
  expect(up.getAttribute('style') ?? '').toMatch(/220,\s*38,\s*38/);
  expect(down.getAttribute('style') ?? '').toMatch(/37,\s*99,\s*235/);
});

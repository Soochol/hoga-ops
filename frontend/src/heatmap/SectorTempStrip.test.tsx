import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { SectorTempStrip } from './SectorTempStrip';
import type { HeatmapGroup } from './heat';
import type { LiveQuote } from '../api/liveQuotes';
import type { HeatmapEntry } from '../api/heatmap';

const entry = (code: string, folderId: string, order = 0): HeatmapEntry => ({
  code, name: code, folder_id: folderId, order,
});

const groups: HeatmapGroup[] = [
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

it('상승 칩 배경 = 적(--price-up), 하락 칩 = 청(--price-down) 토큰', () => {
  render(<SectorTempStrip groups={groups} quoteByCode={quoteByCode} onJump={() => {}} />);
  const up = screen.getAllByRole('button')[0];   // 로봇 +4
  const down = screen.getAllByRole('button')[2]; // 통신 -2
  // heat.ts 는 color-mix(in srgb, var(--price-*) …) 로 테마 자동 추종.
  expect(up.getAttribute('style') ?? '').toContain('var(--price-up)');
  expect(down.getAttribute('style') ?? '').toContain('var(--price-down)');
});

it('stale 종목도 평균/칩에 포함된다 (stale 배치에 스트립이 사라지지 않음)', () => {
  // stale 은 마지막 정상값 — 평균/표시에 그대로 반영한다. 전 종목 stale 이어도 칩은 유지된다.
  const staleGroups: HeatmapGroup[] = [
    { folder: { id: 'f1', name: '로봇', order: 0 }, entries: [entry('111', 'f1')] },      // +2
    { folder: { id: 'f2', name: '통신', order: 1 }, entries: [entry('222', 'f2')] },      // -3
    { folder: { id: 'f3', name: '반도체', order: 2 }, entries: [entry('005930', 'f3')] },   // stale +20 (포함 → 맨 위)
  ];
  const staleQuoteByCode = new Map<string, LiveQuote>([
    ['111', { code: '111', price: 1, change_pct: 2, change_won: 0 }],
    ['222', { code: '222', price: 1, change_pct: -3, change_won: 0 }],
    ['005930', { code: '005930', price: 1, change_pct: 20, change_won: 0, stale: true }],
  ]);

  render(<SectorTempStrip groups={staleGroups} quoteByCode={staleQuoteByCode} onJump={() => {}} />);
  const chips = screen.getAllByRole('button').map((c) => c.textContent ?? '');
  expect(chips).toHaveLength(3);
  expect(chips[0]).toContain('반도체'); // stale +20 → 맨 위
  expect(chips[1]).toContain('로봇');   // +2
  expect(chips[2]).toContain('통신');   // -3
});

it('전 종목 stale 이어도 스트립은 유지된다 (스트립 소실 회귀 가드)', () => {
  const allStaleGroups: HeatmapGroup[] = [
    { folder: { id: 'f1', name: '로봇', order: 0 }, entries: [entry('111', 'f1')] },
    { folder: { id: 'f2', name: '통신', order: 1 }, entries: [entry('222', 'f2')] },
  ];
  const allStale = new Map<string, LiveQuote>([
    ['111', { code: '111', price: 1, change_pct: 2, change_won: 0, stale: true }],
    ['222', { code: '222', price: 1, change_pct: -3, change_won: 0, stale: true }],
  ]);
  render(<SectorTempStrip groups={allStaleGroups} quoteByCode={allStale} onJump={() => {}} />);
  expect(screen.getAllByRole('button')).toHaveLength(2);
});

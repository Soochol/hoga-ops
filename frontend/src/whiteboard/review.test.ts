import { afterEach, expect, it } from 'vitest';
import { DISPLAY_KEY, initialDisplay, sortedNotes, todayKst, writePreference, emptyReview } from './review';
import type { WhiteboardSummary } from '../api/whiteboards';

afterEach(() => localStorage.clear());
it('uses the Korean calendar day across UTC midnight and US browser zones', () => {
  expect(todayKst(new Date('2026-10-23T14:59:59Z'))).toBe('2026-10-23');
  expect(todayKst(new Date('2026-10-23T15:00:00Z'))).toBe('2026-10-24');
});
it('sorts by note date, independent of later edits and legacy boards', () => {
  const board = (id: string, date: string, updated: number): WhiteboardSummary => ({ id, name: id, revision: 1,
    deleted_at_ms: null, element_count: 0, created_at_ms: 1, updated_at_ms: updated, review: emptyReview(date) });
  expect(sortedNotes([board('old', '2026-10-21', 999), { id: 'legacy' } as WhiteboardSummary,
    board('new', '2026-10-24', 1), board('middle', '2026-10-23', 7)]).map(b => b.id)).toEqual(['new', 'middle', 'old']);
});
it('remembers both display choices and falls back from damaged settings', () => {
  expect(initialDisplay()).toBe('detail');
  expect(writePreference(DISPLAY_KEY, 'compact')).toBe(true);
  expect(initialDisplay()).toBe('compact');
  writePreference(DISPLAY_KEY, 'detail'); expect(initialDisplay()).toBe('detail');
  localStorage.setItem(DISPLAY_KEY, '{broken'); expect(initialDisplay()).toBe('detail');
});

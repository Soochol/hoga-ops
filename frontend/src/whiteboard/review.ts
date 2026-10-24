import { boardId, type ReviewNote, type ReviewRecord, type WhiteboardSummary } from '../api/whiteboards';

export const DISPLAY_KEY = 'ticklane.review.list-display.v1';
export type ListDisplay = 'compact' | 'detail';
export function readPreference<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; }
  catch { return fallback; }
}
export function writePreference(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
export function initialDisplay(): ListDisplay {
  return readPreference<ListDisplay>(DISPLAY_KEY, 'detail') === 'compact' ? 'compact' : 'detail';
}
export function todayKst(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function dateLabel(value: string, full = false): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: full ? 'long' : 'numeric', day: 'numeric',
    ...(full ? { year: 'numeric', weekday: 'long' } as const : {}),
  }).format(new Date(`${value}T12:00:00+09:00`));
}
export function sortedNotes(boards: WhiteboardSummary[]) {
  return boards.filter(b => b.review).sort((a, b) =>
    b.review!.date.localeCompare(a.review!.date) || a.created_at_ms - b.created_at_ms || a.id.localeCompare(b.id));
}
export function emptyRecord(): ReviewRecord {
  return { id: boardId(), title: '', stock: '', code: '', timeframe: '', captured_at_ms: null,
    image_file_id: null, judgment: '', action: '', result: '' };
}
export function emptyReview(date: string): ReviewNote {
  return { date, summary: '', completed: false, stocks: [], good: '', change: '', principle: '', records: [] };
}
export function noteViewKey(server: string, id: string) { return `ticklane.review.view.v1:${server}:${id}`; }

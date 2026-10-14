import { compactStudyViewPeriod, studyTimeframeLabel } from './studyViewPeriod';
import { normalizeStudyViewQuery } from './studyViewTree';


export function filterStudyViews<T extends { name: string; code: string; memo: string }>(rows: T[], query: string): T[] {
  const q = normalizeStudyViewQuery(query);
  if (!q) return rows;
  return rows.filter((row) => [row.name, row.code, row.memo].some((v) => normalizeStudyViewQuery(v).includes(q)));
}


/** 이미 종목명으로 시작하는 저장 이름에는 종목명을 다시 붙이지 않는다. */
export function formatStudyViewTitle(row: { label: string; code: string; name: string }): string {
  const stock = row.label || row.code;
  const name = row.name.trim();
  const suffix = name.slice(stock.length);
  // Old generated names repeat the code, timeframe and full date range; the
  // metadata row already displays those. Keep authored study names intact.
  if (name.startsWith(stock) && suffix.trim().startsWith(row.code)
    && /^\s*[·-]\s*(?:일봉|주봉|월봉|\d+분봉)\s*[·-]\s*[\d.\-–:~\s]+(?:KST)?$/.test(suffix.trim().slice(row.code.length))) return stock;
  return name.startsWith(stock) && (suffix === '' || /^[\s·:：—–-]/.test(suffix))
    ? name
    : `${stock} · ${name}`;
}


export function formatStudyViewMeta(row: { timeframe: string; range: { from_date: string; to_date: string; from_ms?: number; to_ms?: number } }): string {
  return `${studyTimeframeLabel(row.timeframe)} · ${compactStudyViewPeriod(row.range, row.timeframe)}`;
}

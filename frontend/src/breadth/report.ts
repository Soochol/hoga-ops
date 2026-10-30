/** Offline report wire: produced by docs/research/2026-10-30-etf-insights-page/build_page.py. */
export type Value = number | null;
export type Fund = {
  code: string; name: string; style: 'active' | 'passive'; stockCount: number;
  status: 'ready' | 'price_capture_required' | 'insufficient_listing_history';
  score: Value; d5: Value; d20: Value; periods: Record<string, Value>;
  persistence: { streak: Value; atLeast: boolean; up5: Value };
  line: Value[]; validDays: number; firstDate: string | null; issuerMatched: boolean;
  pendingCount: number; youngCount: number;
};
export type StockContribution = {
  code: string; name: string; before: number; now: number; changes: number[]; contribution: number;
};
export type Changes = {
  population: number; improved: number; declined: number; unchanged: number; cancelling: number;
  beforeScore: number; score: number; change: number; positive: number; negative: number;
  from: string; to: string;
  periods: { period: number; entry: number; exit: number; net: number; contribution: number }[];
  stocks: StockContribution[];
  history: { date: string; improved: Value; declined: Value; unchanged: Value }[];
};
type Position = { n: number; lower_count: number; lower_pct: number };
export type BreadthReport = {
  schemaVersion: 1; asOf: string; adjustedAsOf: string; holdingsDate: string; sourceSnapshot: string;
  dates: string[]; population: number; membershipRows: number;
  baseline: {
    score: number; d1: number; d5: number; d20: number; line: Value[]; periodLines: Value[][];
    periods: { period: number; above: number; percent: number }[]; allAbove: number; noneAbove: number;
  };
  rarity: { original: Position; cohort: Position; cohortScore: number; cohortSize: number };
  funds: Fund[]; benchmarks: { code: string; name: string; drawdown: Value[]; volatility: Value[] }[];
  changes: Record<'5' | '20', Changes>;
};

export const REPORT_URL = '/market-breadth/snapshot.json';
export const SELECTION_KEY = 'hoga.breadth.selection.v1';
export const DEFAULT_SELECTION = ['140700', '102970', '0221Z0'];

export function parseReport(input: unknown): BreadthReport {
  // Reject a wrong version, HTML fallback, broken alignment or unavailable endpoint;
  // never replace failed data with a plausible-looking score.
  const r = input as BreadthReport | null;
  const lineOK = (line: unknown): line is Value[] => Array.isArray(line)
    && line.length === r?.dates?.length && line.every(v => v === null || (typeof v === 'number' && Number.isFinite(v)));
  if (!r || r.schemaVersion !== 1 || !Array.isArray(r.dates) || r.dates.length < 21
    || r.dates.some((d, i) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || (i > 0 && d <= r.dates[i - 1]))
    || r.dates.at(-1) !== r.asOf || !(r.population > 0) || !r.baseline
    || !lineOK(r.baseline.line) || r.baseline.line.at(-1) !== r.baseline.score
    || !Array.isArray(r.baseline.periodLines) || r.baseline.periodLines.length !== 3
    || !r.baseline.periodLines.every(lineOK) || !Array.isArray(r.funds)
    || !r.funds.every(f => lineOK(f.line) && ['ready', 'price_capture_required', 'insufficient_listing_history'].includes(f.status))
    || !r.benchmarks?.every(b => lineOK(b.drawdown) && lineOK(b.volatility))
    || !r.changes?.['5'] || !r.changes['20'] || !r.rarity?.original || !r.rarity.cohort) {
    throw new Error('공탐지수 자료 형식을 확인할 수 없습니다.');
  }
  for (const h of ['5', '20'] as const) {
    const c = r.changes[h];
    if (c.population !== r.population || c.improved + c.declined + c.unchanged !== r.population
      || c.stocks.length !== r.population || new Set(c.stocks.map(s => s.code)).size !== r.population
      || Math.abs(c.stocks.reduce((sum, s) => sum + s.contribution, 0) - c.change) > 1e-8) {
      throw new Error('공탐지수 종목별 합계를 검증하지 못했습니다.');
    }
  }
  return r;
}

export async function loadReport({ signal }: { signal?: AbortSignal } = {}): Promise<BreadthReport> {
  const response = await fetch(REPORT_URL, { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error('공탐지수 자료를 불러오지 못했습니다.');
  return parseReport(await response.json());
}

export function selectedCodes(saved: unknown, funds: Fund[]): string[] {
  const ready = new Set(funds.filter(f => f.status === 'ready').map(f => f.code));
  const values = Array.isArray(saved) ? saved : DEFAULT_SELECTION;
  return [...new Set(values.filter((c): c is string => typeof c === 'string' && ready.has(c)))];
}

/** Keep the same ready ETF cohort throughout; gaps never shrink the divisor. */
export function etfImprovementCounts(funds: Fund[], horizon: number): Value[] {
  const ready = funds.filter(f => f.status === 'ready');
  if (!ready.length) return [];
  return ready[0].line.map((_, i) => {
    if (i < horizon || ready.some(f => f.line[i] === null || f.line[i - horizon] === null)) return null;
    return ready.filter(f => f.line[i]! - f.line[i - horizon]! > 1e-7).length;
  });
}

export const number = (v: Value | undefined, digits = 2) => v == null ? '—' : v.toFixed(digits);
export const signed = (v: Value | undefined, digits = 2) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;

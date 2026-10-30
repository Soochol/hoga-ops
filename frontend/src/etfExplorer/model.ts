/** Static producer contract: docs/research/2026-10-30-etf-explorer/build_snapshot.py. */
export type MaState = 'above' | 'below' | 'equal';
export type Holding = { code: string; weightBps: number };
export type EtfFund = {
  code: string; name: string; style: 'active' | 'passive'; issuer: string; benchmark: string | null;
  score: number | null; status: 'ready' | 'price_capture_required' | 'insufficient_listing_history';
  issuerMatched: boolean; holdings: Holding[]; otherAssets: { name: string; kind: string; weightBps: number }[];
};
export type EtfSnapshot = {
  schemaVersion: 1; holdingsAsOf: string; priceAsOf: string;
  funds: EtfFund[]; stocks: Record<string, { name: string; states: [MaState, MaState, MaState] | null }>;
};
export type Membership = { fund: EtfFund; weightBps: number };
export type EtfIndex = { snapshot: EtfSnapshot; funds: Map<string, EtfFund>; memberships: Map<string, Membership[]> };
export type FilterStyle = 'all' | 'active' | 'passive';
export type OverlapView = 'common' | 'left' | 'right';
export type ExplorerPrefs = {
  code: string; style: FilterStyle; issuer: string; query: string;
  compare: string[]; pair: [string, string] | null; view: OverlapView;
};
export const PREFS_KEY = 'hoga.etf-explorer.v1';
export const SNAPSHOT_URL = '/etf-explorer/snapshot.json';
export const MAX_COMPARE = 4;
export const styleLabel = (f: EtfFund) => f.style === 'active' ? '액티브' : '패시브';
export const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;
export const totalBps = (holdings: Holding[]) => holdings.reduce((sum, h) => sum + h.weightBps, 0);
export const scoreLabel = (f: EtfFund) => f.score !== null ? `${f.score.toFixed(2)} / 100`
  : f.status === 'insufficient_listing_history' ? '상장 이력 부족' : '확정 입력 검증 대기';

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const weight = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10000;
const validDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export function parseSnapshot(input: unknown): EtfSnapshot {
  const fail = (): never => { throw new Error('ETF 구성 자료 형식을 확인할 수 없습니다.'); };
  if (!record(input) || input.schemaVersion !== 1 || !validDate(input.holdingsAsOf)
    || !validDate(input.priceAsOf) || !record(input.stocks) || !Array.isArray(input.funds) || !input.funds.length) return fail();
  const stocks = input.stocks, used = new Set<string>(), fundCodes = new Set<string>();
  for (const [code, stock] of Object.entries(stocks)) {
    if (!/^[0-9A-Z]{6}$/.test(code) || !record(stock) || !text(stock.name)
      || (stock.states !== null && (!Array.isArray(stock.states) || stock.states.length !== 3
        || !stock.states.every(v => ['above', 'below', 'equal'].includes(v))))) return fail();
  }
  for (const f of input.funds) {
    if (!record(f) || !text(f.code) || !/^[0-9A-Z]{6}$/.test(f.code) || fundCodes.has(f.code)
      || !text(f.name) || !text(f.issuer) || !['active', 'passive'].includes(String(f.style))
      || !(f.benchmark === null || typeof f.benchmark === 'string') || typeof f.issuerMatched !== 'boolean'
      || !['ready', 'price_capture_required', 'insufficient_listing_history'].includes(String(f.status))
      || !Array.isArray(f.holdings) || !f.holdings.length || !Array.isArray(f.otherAssets)) return fail();
    if (f.status === 'ready' ? typeof f.score !== 'number' || !Number.isFinite(f.score) || f.score < 0 || f.score > 100 : f.score !== null) return fail();
    fundCodes.add(f.code);
    const held = new Set<string>();
    for (const h of f.holdings) {
      if (!record(h) || !text(h.code) || !Object.hasOwn(stocks, h.code) || held.has(h.code) || !weight(h.weightBps)) return fail();
      held.add(h.code); used.add(h.code);
    }
    for (const asset of f.otherAssets) if (!record(asset) || !text(asset.name) || !text(asset.kind) || typeof asset.weightBps !== 'number' || !weight(Math.abs(asset.weightBps))) return fail();
  }
  if (Object.keys(stocks).length !== used.size) return fail();
  return input as EtfSnapshot;
}

export async function loadSnapshot({ signal }: { signal?: AbortSignal } = {}): Promise<EtfSnapshot> {
  const response = await fetch(SNAPSHOT_URL, { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error('ETF 구성 자료를 불러오지 못했습니다.');
  return parseSnapshot(await response.json());
}

export function buildIndex(snapshot: EtfSnapshot): EtfIndex {
  const funds = new Map(snapshot.funds.map(f => [f.code, f])), memberships = new Map<string, Membership[]>();
  for (const fund of snapshot.funds) for (const holding of fund.holdings) {
    const rows = memberships.get(holding.code) ?? [];
    rows.push({ fund, weightBps: holding.weightBps }); memberships.set(holding.code, rows);
  }
  for (const rows of memberships.values()) rows.sort((a, b) => b.weightBps - a.weightBps || a.fund.code.localeCompare(b.fund.code));
  return { snapshot, funds, memberships };
}

const PRIORITY = ['444200', '091160', '445290', '0221Z0', '422420', '385710'];
export function searchFunds(index: EtfIndex, filter: Pick<ExplorerPrefs, 'style' | 'issuer' | 'query'>): EtfFund[] {
  const q = filter.query.trim().toLocaleLowerCase(), stocks = Object.entries(index.snapshot.stocks);
  const exact = q ? stocks.filter(([code, s]) => code.toLocaleLowerCase() === q || s.name.toLocaleLowerCase() === q) : [];
  const matches = new Set((exact.length ? exact : q ? stocks.filter(([code, s]) => `${s.name} ${code}`.toLocaleLowerCase().includes(q)) : []).map(([code]) => code));
  return index.snapshot.funds.filter(f => (filter.style === 'all' || f.style === filter.style)
    && (!filter.issuer || f.issuer === filter.issuer)
    && (!q || `${f.name} ${f.code}`.toLocaleLowerCase().includes(q) || f.holdings.some(h => matches.has(h.code))))
    .sort((a, b) => {
      const pa = PRIORITY.indexOf(a.code), pb = PRIORITY.indexOf(b.code);
      return (pa < 0 ? PRIORITY.length : pa) - (pb < 0 ? PRIORITY.length : pb) || a.name.localeCompare(b.name, 'ko');
    });
}

export function compareFunds(left: EtfFund, right: EtfFund) {
  const a = new Map(left.holdings.map(h => [h.code, h.weightBps])), b = new Map(right.holdings.map(h => [h.code, h.weightBps]));
  const common = left.holdings.filter(h => b.has(h.code)).map(h => h.code);
  const leftOnly = left.holdings.filter(h => !b.has(h.code)).map(h => h.code);
  const rightOnly = right.holdings.filter(h => !a.has(h.code)).map(h => h.code);
  return { common, leftOnly, rightOnly, leftWeights: a, rightWeights: b,
    overlapBps: common.reduce((sum, code) => sum + Math.min(a.get(code)!, b.get(code)!), 0) };
}

export function restorePrefs(saved: Record<string, unknown>, index: EtfIndex): ExplorerPrefs {
  const valid = (v: unknown): v is string => typeof v === 'string' && index.funds.has(v);
  const compare = Array.isArray(saved.compare) ? [...new Set(saved.compare.filter(valid))].slice(0, MAX_COMPARE)
    : ['444200', '091160'].filter(c => index.funds.has(c));
  const pair = Array.isArray(saved.pair) && saved.pair.length === 2 && saved.pair[0] !== saved.pair[1]
    && saved.pair.every(c => typeof c === 'string' && compare.includes(c)) ? saved.pair as [string, string] : null;
  return {
    code: valid(saved.code) ? saved.code : index.funds.has('444200') ? '444200' : index.snapshot.funds[0].code,
    style: ['all', 'active', 'passive'].includes(String(saved.style)) ? saved.style as FilterStyle : 'all',
    issuer: typeof saved.issuer === 'string' && index.snapshot.funds.some(f => f.issuer === saved.issuer) ? saved.issuer : '',
    query: typeof saved.query === 'string' ? saved.query.slice(0, 100) : '', compare, pair,
    view: ['common', 'left', 'right'].includes(String(saved.view)) ? saved.view as OverlapView : 'common',
  };
}

import { describe, expect, it, vi } from 'vitest';
import snapshotText from '../../public/etf-explorer/snapshot.json?raw';
import { buildIndex, compareFunds, loadSnapshot, parseSnapshot, percent, restorePrefs, searchFunds, totalBps, type EtfFund } from './model';

const snapshot = parseSnapshot(JSON.parse(snapshotText));
const index = buildIndex(snapshot);
const filter = { style: 'all' as const, issuer: '', query: '' };

describe('ETF explorer frozen data and composition math', () => {
  it('loads all 119 funds independently of score readiness and preserves signed non-stock assets', () => {
    expect(snapshot.funds).toHaveLength(119);
    expect(snapshot.funds.filter(f => f.style === 'active')).toHaveLength(81);
    expect(snapshot.funds.filter(f => f.status === 'ready')).toHaveLength(42);
    expect(snapshot.funds.reduce((sum, f) => sum + f.holdings.length, 0)).toBe(4937);
    expect(index.memberships.size).toBe(896);
    expect(index.funds.get('445290')).toMatchObject({ score: null, status: 'price_capture_required' });
    expect(index.funds.get('445290')!.holdings).toHaveLength(32);
    expect(index.funds.get('403790')!.otherAssets.some(a => a.weightBps === -38)).toBe(true);
    expect(percent(-38)).toBe('-0.38%');
  });
  it('finds exact stocks without mixing preferred shares, and supports partial and alphanumeric code search', () => {
    expect(searchFunds(index, { ...filter, query: '삼성전자' })).toHaveLength(46);
    expect(searchFunds(index, { ...filter, query: '005930' }).map(f => f.code)).toEqual(searchFunds(index, { ...filter, query: '삼성전자' }).map(f => f.code));
    expect(searchFunds(index, { ...filter, query: '삼성전자우' }).every(f => f.holdings.some(h => h.code === '005935'))).toBe(true);
    expect(searchFunds(index, { ...filter, query: '0221z0' }).map(f => f.code)).toEqual(['0221Z0']);
    expect(searchFunds(index, { ...filter, query: '존재하지않는종목' })).toEqual([]);
    expect(searchFunds(index, { ...filter, style: 'active' })).toHaveLength(81);
    expect(searchFunds(index, { ...filter, style: 'passive' })).toHaveLength(38);
  });
  it('reverse lookup uses every fund once and retains its original weight', () => {
    const rows = index.memberships.get('005930')!;
    expect(rows).toHaveLength(46);
    expect(rows.filter(r => r.fund.style === 'active')).toHaveLength(43);
    expect(new Set(rows.map(r => r.fund.code)).size).toBe(rows.length);
    expect(rows.find(r => r.fund.code === '444200')!.weightBps).toBe(2696);
  });
  it('calculates symmetric overlap using exact basis points without normalizing direct-stock totals', () => {
    const a = index.funds.get('444200')!, b = index.funds.get('091160')!;
    const result = compareFunds(a, b);
    expect(result.common).toHaveLength(3);
    expect(result.overlapBps).toBe(3720);
    expect(compareFunds(b, a).overlapBps).toBe(3720);
    expect(result.common.length + result.leftOnly.length).toBe(a.holdings.length);
    expect(result.common.length + result.rightOnly.length).toBe(b.holdings.length);
    expect(totalBps(a.holdings)).toBe(9935);
    expect(compareFunds(a, a).overlapBps).toBe(9935);
    expect(percent(totalBps(a.holdings.slice(0, 5)))).toBe('58.13%');
  });
  it('counts zero-weight disclosed positions as holdings and distinguishes absence', () => {
    const base = index.funds.get('444200')!;
    const a: EtfFund = { ...base, holdings: [{ code: '005930', weightBps: 0 }] };
    const b: EtfFund = { ...base, holdings: [{ code: '005930', weightBps: 50 }, { code: '000660', weightBps: 100 }] };
    const r = compareFunds(a, b);
    expect(r.common).toEqual(['005930']); expect(r.overlapBps).toBe(0);
    expect(r.leftWeights.has('005930')).toBe(true); expect(r.leftWeights.has('000660')).toBe(false);
  });
  it('keeps clear-all on reload and sanitizes invalid or duplicate persisted state', () => {
    expect(restorePrefs({ compare: [] }, index).compare).toEqual([]);
    const p = restorePrefs({ code: 'bad', style: 'bad', issuer: 'bad', compare: ['444200', '444200', null, '091160', '445290', '0221Z0', '422420'], pair: ['bad', '091160'], view: 'bad' }, index);
    expect(p).toMatchObject({ code: '444200', style: 'all', issuer: '', pair: null, view: 'common' });
    expect(p.compare).toEqual(['444200', '091160', '445290', '0221Z0']);
  });
  it('rejects invalid schema, dangling or duplicate holdings, fake scores and truncated MA states', () => {
    expect(() => parseSnapshot(null)).toThrow();
    const variants = [
      (r: typeof snapshot) => { r.funds[0].holdings.push(r.funds[0].holdings[0]); },
      (r: typeof snapshot) => { r.funds[0].holdings[0].code = 'bad'; },
      (r: typeof snapshot) => { r.funds[0].holdings[0].weightBps = -1; },
      (r: typeof snapshot) => { r.funds.find(f => f.score === null)!.score = 0; },
      (r: typeof snapshot) => { r.stocks['005930'].states = ['above'] as never; },
    ];
    for (const modify of variants) { const r = structuredClone(snapshot); modify(r); expect(() => parseSnapshot(r)).toThrow(); }
  });
  it('fails closed on a failed request and forwards cancellation', async () => {
    const request = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', request);
    try {
      const controller = new AbortController();
      await expect(loadSnapshot({ signal: controller.signal })).rejects.toThrow('자료를 불러오지 못했습니다');
      expect(request.mock.calls[0][1].signal).toBe(controller.signal);
    } finally { vi.unstubAllGlobals(); }
  });
});

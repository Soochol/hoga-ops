import { describe, expect, it } from 'vitest';
import type { SymbolHit } from '../api/types';
import { buildLiveSearchCatalog, searchItemIdentity, searchLiveCatalog } from './liveSymbolSearchModel';

function stock(code: string, name: string): SymbolHit {
  return { code, name, market: 'KOSPI', captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } };
}
const stocks = [stock('005935', '삼성전자우'), stock('005930', '삼성전자'),
  stock('111111', '미래삼성전자'), stock('000660', 'SK하이닉스'), stock('035420', 'NAVER')];
const catalog = buildLiveSearchCatalog(stocks, [
  { kind: 'index', id: 'KOSPI200', label: '코스피 200', investorScope: 'none' },
  { kind: 'index', id: 'KOSPI', label: '코스피', investorScope: 'market' },
]);
const codes = (q: string, limit = 20) => searchLiveCatalog(catalog, q, limit).map((item) => searchItemIdentity(item).code);

describe('live search ranking', () => {
  it('puts exact name/code first, then prefixes, then substrings', () => {
    expect(codes('삼성전자')).toEqual(['005930', '005935', '111111']);
    expect(codes('005930')).toEqual(['005930']);
    expect(codes('00593')).toEqual(['005930', '005935']);
    expect(codes('5930')).toEqual([]); // stock codes use prefixes, preserving leading zeros
  });
  it('matches Hangul initials and mixed Latin/Hangul initials without mutating the catalog', () => {
    expect(codes(' ㅅㅅㅈㅈ ')).toEqual(['005930', '005935', '111111']);
    expect(codes('skㅎㅇㄴㅅ')).toEqual(['000660']);
    expect(codes('naver')).toEqual(['035420']);
    expect(stocks[0].code).toBe('005935');
  });
  it('ranks stock and index results together and matches both index names and IDs', () => {
    expect(codes('kospi')).toEqual(['KOSPI', 'KOSPI200']);
    expect(codes('ㅋㅅㅍ')).toEqual(['KOSPI', 'KOSPI200']);
    const mixed = buildLiveSearchCatalog([stock('111111', '코스피')], [
      { kind: 'index', id: 'KOSPI200', label: '코스피 200', investorScope: 'none' },
    ]);
    expect(searchLiveCatalog(mixed, '코스피')[0].kind).toBe('stock');
  });
  it('applies limits after ranking, returns nothing for blank/unmatched queries, and stays deterministic', () => {
    expect(codes('삼성전자', 1)).toEqual(['005930']);
    expect(codes('')).toEqual([]);
    expect(codes('없는종목')).toEqual([]);
    expect(codes('삼성')).toEqual(codes('삼성'));
  });
});

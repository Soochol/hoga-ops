import { describe, it, expect } from 'vitest';
import type { ObSnapshot } from '../live/bucketHogaSeries';
import { advanceBadges, computeOrderbookDeltas, BADGE_TTL_MS } from './orderbookDeltaBadges';

const book = (
  t: number,
  askBump: number,
  bidBump: number,
  venue: 'KRX' | 'NXT' = 'KRX',
): ObSnapshot => ({
  t_ms: t,
  total_ask_qty: 1000,
  total_bid_qty: 1000,
  venue,
  asks: Array.from({ length: 10 }, (_, i) => ({ price: 1000 + i * 10, qty: 100 + (i === 0 ? askBump : 0) })),
  bids: Array.from({ length: 10 }, (_, i) => ({ price: 990 - i * 10, qty: 100 + (i === 0 ? bidBump : 0) })),
});

describe('computeOrderbookDeltas', () => {
  it('같은 가격끼리 diff 해 side 접두 키로 낸다', () => {
    const out = computeOrderbookDeltas(book(1, 0, 0), book(2, 50, -30));
    expect(out.get('a:1000')).toBe(50);
    expect(out.get('b:990')).toBe(-30);
    expect(out.size).toBe(2);
  });

  it('관측창 이동(교집합 밖 가격)은 증감이 아니다', () => {
    const prev = book(1, 0, 0);
    const cur: ObSnapshot = {
      ...book(2, 0, 0),
      // 사다리가 한 단 위로 — 1100 이 새로 들어옴(prev 에 없음).
      asks: Array.from({ length: 10 }, (_, i) => ({ price: 1010 + i * 10, qty: 100 })),
    };
    const out = computeOrderbookDeltas(prev, cur);
    expect([...out.keys()].some((k) => k === 'a:1100')).toBe(false);
    expect(out.size).toBe(0); // 교집합(1010..1090)은 전부 100→100
  });

  it('venue 가 바뀌면 diff 하지 않는다 (KRX↔NXT 별개 장부)', () => {
    expect(computeOrderbookDeltas(book(1, 0, 0, 'KRX'), book(2, 50, 0, 'NXT')).size).toBe(0);
  });

  it('동시호가 붕괴책(3호가)은 diff 하지 않는다', () => {
    const shallow: ObSnapshot = {
      ...book(2, 0, 0),
      asks: Array.from({ length: 10 }, (_, i) => ({ price: 1000 + i * 10, qty: i < 3 ? 999 : 0 })),
      bids: Array.from({ length: 10 }, (_, i) => ({ price: 990 - i * 10, qty: i < 3 ? 999 : 0 })),
    };
    expect(computeOrderbookDeltas(book(1, 0, 0), shallow).size).toBe(0);
  });

  it('totals-only 스냅샷은 diff 하지 않는다', () => {
    const totalsOnly: ObSnapshot = { t_ms: 2, total_ask_qty: 1, total_bid_qty: 1 };
    expect(computeOrderbookDeltas(book(1, 0, 0), totalsOnly).size).toBe(0);
    expect(computeOrderbookDeltas(totalsOnly, book(2, 0, 0)).size).toBe(0);
  });
});

describe('advanceBadges', () => {
  it('새 증감은 뱃지를 교체하고 TTL 지난 뱃지는 정리한다', () => {
    const s1 = advanceBadges(new Map(), new Map([['a:1000', 50]]), 0);
    expect(s1.get('a:1000')).toEqual({ delta: 50, atMs: 0 });
    // TTL 안: 유지 + 새 키 추가.
    const s2 = advanceBadges(s1, new Map([['b:990', -30]]), BADGE_TTL_MS);
    expect(s2.get('a:1000')).toEqual({ delta: 50, atMs: 0 });
    expect(s2.get('b:990')).toEqual({ delta: -30, atMs: BADGE_TTL_MS });
    // TTL 초과: a:1000 정리.
    const s3 = advanceBadges(s2, new Map(), BADGE_TTL_MS + 1);
    expect(s3.has('a:1000')).toBe(false);
    expect(s3.has('b:990')).toBe(true);
  });

  it('변화가 없으면 같은 참조를 돌려준다 (하류 memo 유지)', () => {
    const s1 = advanceBadges(new Map(), new Map([['a:1000', 50]]), 0);
    expect(advanceBadges(s1, new Map(), 100)).toBe(s1);
  });

  it('같은 가격의 연속 증감은 최신 값으로 교체된다 (페이드 재시작)', () => {
    const s1 = advanceBadges(new Map(), new Map([['a:1000', 50]]), 0);
    const s2 = advanceBadges(s1, new Map([['a:1000', -20]]), 500);
    expect(s2.get('a:1000')).toEqual({ delta: -20, atMs: 500 });
  });
});

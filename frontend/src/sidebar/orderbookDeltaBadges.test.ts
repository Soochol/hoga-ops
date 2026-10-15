import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ObSnapshot } from '../live/bucketHogaSeries';
import { advanceBadges, computeOrderbookDeltas, useOrderbookDeltaBadges, BADGE_TTL_MS } from './orderbookDeltaBadges';

const book = (
  t: number,
  askBump: number,
  bidBump: number,
  venue: 'KRX' | 'NXT' | 'UN' = 'KRX',
): ObSnapshot => ({
  t_ms: t,
  total_ask_qty: 1000,
  total_bid_qty: 1000,
  venue,
  asks: Array.from({ length: 10 }, (_, i) => ({ price: 1000 + i * 10, qty: 100 + (i === 0 ? askBump : 0) })),
  bids: Array.from({ length: 10 }, (_, i) => ({ price: 990 - i * 10, qty: 100 + (i === 0 ? bidBump : 0) })),
});

function auctionBook(t: number, askBump = 0, bidBump = 0, venue: 'KRX' | 'NXT' | 'UN' = 'KRX'): ObSnapshot {
  const full = book(t, askBump, bidBump, venue);
  return { ...full,
    asks: full.asks!.map((level, i) => i < 3 ? level : { price: 0, qty: 0 }),
    bids: full.bids!.map((level, i) => i < 3 ? level : { price: 0, qty: 0 }),
    expected_price: 1000, expected_qty: 323557,
  };
}

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

  it('연속장에서 동시호가로 전환되는 첫 호가는 diff 하지 않는다', () => {
    const shallow: ObSnapshot = {
      ...book(2, 0, 0),
      asks: Array.from({ length: 10 }, (_, i) => ({ price: 1000 + i * 10, qty: i < 3 ? 999 : 0 })),
      bids: Array.from({ length: 10 }, (_, i) => ({ price: 990 - i * 10, qty: i < 3 ? 999 : 0 })),
    };
    expect(computeOrderbookDeltas(book(1, 0, 0), shallow).size).toBe(0);
  });

  it.each(['KRX', 'NXT', 'UN'] as const)('동시호가 안의 같은 가격 잔량은 증감을 표시한다: %s', venue => {
    // Same-second messages still contain distinct book states.
    const prev = auctionBook(2, 0, 0, venue);
    const cur = { ...auctionBook(2, 50, -30, venue), expected_qty: 3 };
    const out = computeOrderbookDeltas(prev, cur);
    expect([...out]).toEqual([['a:1000', 50], ['b:990', -30]]);
  });

  it('동시호가에서 연속장으로 돌아오는 첫 호가는 비교하지 않는다', () => {
    expect(computeOrderbookDeltas(auctionBook(1), book(2, 50, -30)).size).toBe(0);
  });

  it('동시호가라도 다른 거래소나 새로 진입한 가격을 증감으로 해석하지 않는다', () => {
    expect(computeOrderbookDeltas(auctionBook(1), auctionBook(2, 50, -30, 'UN')).size).toBe(0);
    const prev = auctionBook(1);
    const cur = auctionBook(2);
    cur.asks = [{ price: 1030, qty: 9999 }, ...cur.asks!.slice(1)];
    expect(computeOrderbookDeltas(prev, cur).size).toBe(0);
  });

  it('totals-only 스냅샷은 diff 하지 않는다', () => {
    const totalsOnly: ObSnapshot = { t_ms: 2, total_ask_qty: 1, total_bid_qty: 1 };
    expect(computeOrderbookDeltas(book(1, 0, 0), totalsOnly).size).toBe(0);
    expect(computeOrderbookDeltas(totalsOnly, book(2, 0, 0)).size).toBe(0);
  });
});

afterEach(() => vi.useRealTimers());

it('국면이 전환되면 이전 증감 배지를 지우고 다음 동일 국면 쌍부터 비교한다', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const regular = book(2, 50, -30);
  const { result, rerender } = renderHook(({ ob }) => useOrderbookDeltaBadges(ob, true), {
    initialProps: { ob: [book(1, 0, 0), regular] },
  });
  expect(result.current?.get('a:1000')?.delta).toBe(50);
  const auction = auctionBook(3);
  rerender({ ob: [regular, auction] });
  expect(result.current?.size).toBe(0);
  const changedAuction = auctionBook(4, 25, -40);
  rerender({ ob: [auction, changedAuction] });
  expect(result.current?.get('a:1000')?.delta).toBe(25);
  expect(result.current?.get('b:990')?.delta).toBe(-40);
  rerender({ ob: [changedAuction, book(5, 0, 0)] });
  expect(result.current?.size).toBe(0);
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

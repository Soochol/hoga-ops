import { describe, it, expect } from 'vitest';
import {
  filterObByVenue,
  latestOrderbookSnapshot,
  aggregateBrokerSeries,
  latestTradeSummary,
  orderbookSnapshotAtCursor,
} from './liveSidebarAdapters';
import type { ObSnapshot } from './bucketHogaSeries';

// 09:00 KST = 00:00 UTC (KST=UTC+9). 시분할 경계 검증용.
const OPEN_MS = Date.UTC(2026, 4, 18, 0, 0, 0);
const MIN = 60 * 1000;
const HOUR = 3600 * 1000;
const ob = (t_ms: number, venue?: 'KRX' | 'NXT'): ObSnapshot =>
  ({ t_ms, total_ask_qty: 0, total_bid_qty: 0, ...(venue ? { venue } : {}) });

describe('filterObByVenue', () => {
  it('KRX 선택: KRX 태그와 무태그(구백엔드)만 남기고 NXT 배제', () => {
    const input = [ob(1, 'KRX'), ob(2, 'NXT'), ob(3)];
    expect(filterObByVenue(input, 'KRX').map((f) => f.t_ms)).toEqual([1, 3]);
  });

  it('UN(시간대 자동): 프레임 자기 t_ms의 시분할 venue와 일치할 때만 — 08:50 개장동시호가 KRX 유지', () => {
    const input = [
      ob(OPEN_MS - 20 * MIN, 'NXT'), // 08:40 NXT ✓
      ob(OPEN_MS - 20 * MIN, 'KRX'), // 08:40 KRX (교차 클라이언트 주입) ✗
      ob(OPEN_MS - 5 * MIN, 'KRX'),  // 08:55 개장동시호가 KRX ✓
      ob(OPEN_MS - 5 * MIN, 'NXT'),  // 08:55 NXT ✗
      ob(OPEN_MS + HOUR, 'KRX'),     // 10:00 정규장 KRX ✓
    ];
    expect(filterObByVenue(input, 'UN').map((f) => [f.t_ms, f.venue])).toEqual([
      [OPEN_MS - 20 * MIN, 'NXT'],
      [OPEN_MS - 5 * MIN, 'KRX'],
      [OPEN_MS + HOUR, 'KRX'],
    ]);
  });
});

// A continuous-trading book shows depth beyond level 3 (isContinuousBook).
const deepBook = (base = 100) =>
  Array.from({ length: 10 }, (_, i) => ({ price: base + i, qty: i + 1 }));
// The closing auction collapses every book to exactly 3 levels.
const auctionBook = () => [
  { price: 100, qty: 5 },
  { price: 101, qty: 3 },
  { price: 102, qty: 1 },
];

describe('latestOrderbookSnapshot', () => {
  it('returns null for empty input', () => {
    expect(latestOrderbookSnapshot([])).toBeNull();
  });

  it('returns OrderbookSnapshot shape from the latest ob entry', () => {
    const ob = [
      { t_ms: 1, asks: [], bids: [], total_ask_qty: 0, total_bid_qty: 0 },
      {
        t_ms: 2,
        asks: Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty: i + 1 })),
        bids: Array.from({ length: 10 }, (_, i) => ({ price: 99 - i, qty: i + 10 })),
        total_ask_qty: 55,
        total_bid_qty: 100,
      },
    ];
    const snap = latestOrderbookSnapshot(ob);
    expect(snap).not.toBeNull();
    expect(snap!.ts_ms).toBe(2);
    expect(snap!.ask).toHaveLength(10);
    expect(snap!.ask[0]).toEqual({ price: 100, qty: 1 });
    expect(snap!.bid[0]).toEqual({ price: 99, qty: 10 });
    expect(snap!.tot_ask).toBe(55);
    expect(snap!.tot_bid).toBe(100);
  });

  it('pads short ask/bid arrays to length 10 with zeros', () => {
    const snap = latestOrderbookSnapshot([
      { t_ms: 1, asks: [{ price: 100, qty: 5 }], bids: [], total_ask_qty: 5, total_bid_qty: 0 },
    ]);
    expect(snap!.ask).toHaveLength(10);
    expect(snap!.bid).toHaveLength(10);
    expect(snap!.bid[0]).toEqual({ price: 0, qty: 0 });
  });
});

describe('aggregateBrokerSeries', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateBrokerSeries([])).toEqual([]);
  });

  it('builds per-broker time series with signed net (buy = +, sell = -)', () => {
    const broker = [
      {
        t_ms: 1000,
        buy_top: [{ name: '미래에셋', qty: 100 }],
        sell_top: [{ name: '신한', qty: 50 }],
      },
      {
        t_ms: 2000,
        buy_top: [{ name: '미래에셋', qty: 200 }],
        sell_top: [{ name: '신한', qty: 80 }],
      },
    ];
    const series = aggregateBrokerSeries(broker);
    const mirae = series.find((s) => s.broker === '미래에셋');
    const shinhan = series.find((s) => s.broker === '신한');
    expect(mirae?.points).toHaveLength(2);
    expect(mirae?.points[1].net).toBe(200);
    expect(mirae?.dominant_side).toBe('buy');
    expect(shinhan?.points[1].net).toBe(-80);
    expect(shinhan?.dominant_side).toBe('sell');
  });

  it('collapses buy + sell qty for same broker at same ts into one signed point (matches backend query_day_series)', () => {
    // Market-maker case: 키움 appears in both top-5 lists at the same snapshot.
    // Per CONTEXT.md Broker Day-Trajectory: net = SUM(qty * sign(side)) per
    // (broker, ts_ms), so one signed line — not two points where the sell
    // overwrites the buy at cursor projection.
    const broker = [
      {
        t_ms: 1000,
        buy_top: [{ name: '키움', qty: 234423 }],
        sell_top: [{ name: '키움', qty: 253901 }],
      },
    ];
    const series = aggregateBrokerSeries(broker);
    const kiwoom = series.find((s) => s.broker === '키움');
    expect(kiwoom?.points).toHaveLength(1);
    expect(kiwoom?.points[0]).toEqual({ ts_ms: 1000, net: 234423 - 253901 });
    expect(kiwoom?.final_net).toBe(234423 - 253901);
    expect(kiwoom?.dominant_side).toBe('sell');
  });

  it('sorts by final_net desc from strongest net buy to strongest net sell', () => {
    const broker = [
      {
        t_ms: 1000,
        buy_top: [
          { name: '순매수2위', qty: 200 },
          { name: '순매수1위', qty: 500 },
        ],
        sell_top: [
          { name: '순매도1위', qty: 900 },
          { name: '순매도2위', qty: 300 },
        ],
      },
    ];
    const series = aggregateBrokerSeries(broker);
    expect(series.map((entry) => entry.broker)).toEqual([
      '순매수1위',
      '순매수2위',
      '순매도2위',
      '순매도1위',
    ]);
    expect(series.map((entry) => entry.final_net)).toEqual([500, 200, -300, -900]);
  });

  it('returns all broker identities', () => {
    const broker = [
      {
        t_ms: 1000,
        buy_top: Array.from({ length: 5 }, (_, i) => ({ name: `B${i}`, qty: (i + 1) * 100 })),
        sell_top: Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, qty: (i + 1) * 50 })),
      },
      {
        t_ms: 2000,
        buy_top: Array.from({ length: 2 }, (_, i) => ({ name: `B${i + 5}`, qty: (i + 6) * 100 })),
        sell_top: Array.from({ length: 2 }, (_, i) => ({ name: `S${i + 5}`, qty: (i + 6) * 50 })),
      },
    ];
    const series = aggregateBrokerSeries(broker);
    expect(series).toHaveLength(14);
  });

  it('aggregateBrokerSeries returns more than ten broker identities', () => {
    const broker = Array.from({ length: 12 }, (_, i) => ({
      t_ms: 1_800_000_000_000 + i,
      buy_top: [{ name: `Broker${i}`, qty: 100 + i }],
      sell_top: [],
    }));
    expect(aggregateBrokerSeries(broker)).toHaveLength(12);
  });
});

describe('orderbookSnapshotAtCursor (ADR-0044 amendment — SSE buffer fallback)', () => {
  const buf: ObSnapshot[] = [
    { t_ms: 60_000, asks: deepBook(100), bids: deepBook(99), total_ask_qty: 10, total_bid_qty: 20 },
    { t_ms: 90_000, asks: deepBook(200), bids: deepBook(199), total_ask_qty: 30, total_bid_qty: 40 },
    { t_ms: 130_000, asks: deepBook(300), bids: deepBook(299), total_ask_qty: 50, total_bid_qty: 60 },
  ];

  it('returns the last continuous book in the cursor bucket', () => {
    const snap = orderbookSnapshotAtCursor(buf, 95_000, 60_000); // bucket [60000, 120000)
    expect(snap).not.toBeNull();
    expect(snap!.ts_ms).toBe(90_000);
    expect(snap!.ask[0]).toEqual({ price: 200, qty: 1 });
    expect(snap!.tot_ask).toBe(30);
    expect(snap!.ask).toHaveLength(10);
  });

  it('aligns cursorMs to the bucket floor (mid-bucket cursor → same bucket)', () => {
    expect(orderbookSnapshotAtCursor(buf, 119_999, 60_000)!.ts_ms).toBe(90_000);
    expect(orderbookSnapshotAtCursor(buf, 60_000, 60_000)!.ts_ms).toBe(90_000);
  });

  it('returns null when no book falls in the cursor bucket (genuine gap → caller keeps empty state)', () => {
    expect(orderbookSnapshotAtCursor(buf, 200_000, 60_000)).toBeNull(); // bucket [180000, 240000)
    expect(orderbookSnapshotAtCursor([], 90_000, 60_000)).toBeNull();
  });

  it('excludes the closing-auction (3-level) book, preferring the last continuous book', () => {
    const ob: ObSnapshot[] = [
      { t_ms: 70_000, asks: deepBook(100), bids: deepBook(99), total_ask_qty: 10, total_bid_qty: 20 },
      { t_ms: 90_000, asks: auctionBook(), bids: auctionBook(), total_ask_qty: 99, total_bid_qty: 99 },
    ];
    // last-in-bucket would be the 90_000 auction book; bucket-representative
    // semantics pick the last *continuous* book (matches backend).
    expect(orderbookSnapshotAtCursor(ob, 95_000, 60_000)!.ts_ms).toBe(70_000);
  });

  it('falls back to the last book when none in the bucket is structurally continuous', () => {
    const ob: ObSnapshot[] = [
      { t_ms: 70_000, asks: auctionBook(), bids: auctionBook(), total_ask_qty: 1, total_bid_qty: 1 },
      { t_ms: 90_000, asks: auctionBook(), bids: auctionBook(), total_ask_qty: 2, total_bid_qty: 2 },
    ];
    expect(orderbookSnapshotAtCursor(ob, 95_000, 60_000)!.ts_ms).toBe(90_000);
  });

  it('skips totals-only frames that carry no book', () => {
    const ob: ObSnapshot[] = [
      { t_ms: 70_000, total_ask_qty: 1, total_bid_qty: 1 }, // no asks/bids
      { t_ms: 80_000, asks: deepBook(), bids: deepBook(), total_ask_qty: 5, total_bid_qty: 5 },
    ];
    expect(orderbookSnapshotAtCursor(ob, 95_000, 60_000)!.ts_ms).toBe(80_000);
  });
});


describe('latestTradeSummary', () => {
  it('빈 버퍼면 전 필드가 null 이다', () => {
    expect(latestTradeSummary([])).toEqual({
      fillStrengthPct: null, vsPrevVolumePct: null, cumVolume: null, cumValue: null,
      dayOpen: null, dayHigh: null, dayLow: null, prevClose: null,
    });
  });

  it('키별로 가장 최근에 관측된 값을 잡는다 (최신 1건만 보지 않는다)', () => {
    // 파서는 미수신/0 인 필드의 키를 아예 싣지 않는다. 최신 프레임에 체결강도가
    // 없어도 직전 프레임의 값은 여전히 유효하다.
    const trade = [
      { t_ms: 1, fill_strength_pct: 94.4, cum_volume: 100, day_open: 250_000 },
      { t_ms: 2, cum_volume: 250 },
      { t_ms: 3, cum_volume: 300, cum_value: 82_400_000_000 },
    ];
    const s = latestTradeSummary(trade);
    expect(s.cumVolume).toBe(300);        // 최신
    expect(s.fillStrengthPct).toBe(94.4); // 첫 프레임에만 있음
    expect(s.dayOpen).toBe(250_000);
    expect(s.cumValue).toBe(82_400_000_000);
    expect(s.dayHigh).toBeNull();         // 어느 프레임에도 없음
  });

  it('0·음수·비수는 미수신으로 접는다', () => {
    const s = latestTradeSummary([
      { t_ms: 1, cum_volume: 0, cum_value: -1, fill_strength_pct: 'x', day_low: 240_000 },
    ]);
    expect(s.cumVolume).toBeNull();
    expect(s.cumValue).toBeNull();
    expect(s.fillStrengthPct).toBeNull();
    expect(s.dayLow).toBe(240_000);
  });
});

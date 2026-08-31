import { describe, it, expect } from 'vitest';
import {
  filterByVenueTag,
  filterObByVenue,
  filterTradeByVenue,
  latestAfterHoursTotals,
  latestOrderbookSnapshot,
  aggregateBrokerSeries,
  latestTradeSummary,
  fillDayOhlcFromQuote,
  EMPTY_TRADE_SUMMARY,
  orderbookSnapshotAtCursor,
} from './liveSidebarAdapters';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { LiveFrameVenue } from './liveVenuePolicy';

// 09:00 KST = 00:00 UTC (KST=UTC+9). 시분할 경계 검증용.
const OPEN_MS = Date.UTC(2026, 4, 18, 0, 0, 0);
const MIN = 60 * 1000;
const HOUR = 3600 * 1000;
const ob = (t_ms: number, venue?: LiveFrameVenue): ObSnapshot =>
  ({ t_ms, total_ask_qty: 0, total_bid_qty: 0, ...(venue ? { venue } : {}) });

describe('filterObByVenue', () => {
  it('KRX 선택: KRX 태그와 무태그(구백엔드)만 남기고 NXT 배제', () => {
    const input = [ob(1, 'KRX'), ob(2, 'NXT'), ob(3)];
    expect(filterObByVenue(input, 'KRX').map((f) => f.t_ms)).toEqual([1, 3]);
  });

  it('UN(통합): UN 태그만 — **시각과 무관**하고 KRX·NXT 합집합이 아니다', () => {
    // ADR-0140 §5. 예전엔 프레임 t_ms 의 시분할 venue 와 태그가 일치할 때만 받았다.
    // 동시 구독이 되면서 같은 시각에 세 태그가 **정상적으로** 도착하므로, 시각으로는
    // 더 이상 정상과 오염을 가를 수 없다. `_AL` 은 거래소가 병합해 내보내는 별도
    // 스트림이라 자기 태그가 있고, 그것만 받으면 이중 계상이 없다.
    const input = [
      ob(OPEN_MS - 20 * MIN, 'UN'),  // 08:40 UN ✓ (예전엔 NXT 시간대라 거절됐다)
      ob(OPEN_MS - 20 * MIN, 'NXT'), // 08:40 NXT ✗ (합집합이 아니다)
      ob(OPEN_MS - 5 * MIN, 'KRX'),  // 08:55 KRX ✗
      ob(OPEN_MS + HOUR, 'UN'),      // 10:00 UN ✓ (예전엔 정규장이라 거절됐다)
    ];
    expect(filterObByVenue(input, 'UN').map((f) => [f.t_ms, f.venue])).toEqual([
      [OPEN_MS - 20 * MIN, 'UN'],
      [OPEN_MS + HOUR, 'UN'],
    ]);
  });

  it('NXT: NXT 태그만 — 정규장 시각의 NXT 프레임도 받는다', () => {
    // 예전 규칙에선 10:00 의 NXT 태그가 "off-venue 오염"이었다. NXT 는 정규장에도
    // 열려 있으므로 이제 정상 데이터다.
    const input = [ob(OPEN_MS + HOUR, 'NXT'), ob(OPEN_MS + HOUR, 'KRX')];
    expect(filterObByVenue(input, 'NXT').map((f) => f.venue)).toEqual(['NXT']);
  });
});

const trade = (t_ms: number, venue?: LiveFrameVenue): TradeSnapshot =>
  ({ t_ms, trades: [], ...(venue ? { venue } : {}) });

describe('filterTradeByVenue (호가 filterObByVenue 와 동일 정책 — 체결 대응물)', () => {
  it('KRX 선택: KRX 태그와 무태그(구백엔드)만 남기고 NXT 배제', () => {
    const input = [trade(1, 'KRX'), trade(2, 'NXT'), trade(3)];
    expect(filterTradeByVenue(input, 'KRX').map((f) => f.t_ms)).toEqual([1, 3]);
  });

  it('UN(통합): UN 태그만 — 호가 필터와 같은 SSOT 술어를 공유한다', () => {
    const input = [
      trade(OPEN_MS - 20 * MIN, 'UN'),  // 08:40 UN ✓
      trade(OPEN_MS - 20 * MIN, 'NXT'), // 08:40 NXT ✗
      trade(OPEN_MS + HOUR, 'KRX'),     // 10:00 KRX ✗
      trade(OPEN_MS + HOUR, 'UN'),      // 10:00 UN ✓
    ];
    expect(filterTradeByVenue(input, 'UN').map((f) => [f.t_ms, f.venue])).toEqual([
      [OPEN_MS - 20 * MIN, 'UN'],
      [OPEN_MS + HOUR, 'UN'],
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

describe('fillDayOhlcFromQuote', () => {
  const empty = { ...EMPTY_TRADE_SUMMARY };

  it('0B 가 비면 시세 오버레이의 당일 시·고·저로 메운다', () => {
    const s = fillDayOhlcFromQuote(empty, { open: 458_500, high: 462_500, low: 424_500 });
    expect([s.dayOpen, s.dayHigh, s.dayLow]).toEqual([458_500, 462_500, 424_500]);
  });

  it('0B 값이 있으면 건드리지 않는다 — 폴백은 결손일 때만', () => {
    const ws = { ...empty, dayOpen: 250_000, dayHigh: 251_000, dayLow: 249_000 };
    const s = fillDayOhlcFromQuote(ws, { open: 1, high: 2, low: 3 });
    expect([s.dayOpen, s.dayHigh, s.dayLow]).toEqual([250_000, 251_000, 249_000]);
    // 아무것도 안 메웠으면 **같은 객체**여야 한다 — 소비처 useMemo 의 헛 리렌더 방지.
    expect(s).toBe(ws);
  });

  it('필드별로 독립이다 — 고가만 있으면 시·저만 메운다', () => {
    const s = fillDayOhlcFromQuote({ ...empty, dayHigh: 470_000 }, {
      open: 458_500, high: 462_500, low: 424_500,
    });
    expect([s.dayOpen, s.dayHigh, s.dayLow]).toEqual([458_500, 470_000, 424_500]);
  });

  it('⚠ 시세의 0 을 값으로 싣지 않는다 — 벤더 파서가 "0" 을 통과시킨다', () => {
    // `kiwoom_multi_quote._abs_int` 는 0 을 걸러 주지 않으므로 첫 체결 전 종목이
    // 0 으로 온다. 그대로 실으면 대시 자리에 "0" 이 뜨고 사다리 칩 판정까지 0 을
    // 가격으로 다룬다 — 여기가 "미제공" 과 "진짜 0" 을 가르는 유일한 지점이다.
    const s = fillDayOhlcFromQuote(empty, { open: 0, high: 0, low: 0 });
    expect([s.dayOpen, s.dayHigh, s.dayLow]).toEqual([null, null, null]);
    expect(s).toBe(empty);
  });

  it('시세가 없으면(undefined·null) 그대로 돌려준다', () => {
    expect(fillDayOhlcFromQuote(empty, undefined)).toBe(empty);
    expect(fillDayOhlcFromQuote(empty, null)).toBe(empty);
  });

  it('폴백이 다른 요약 칸을 지어내지 않는다 — 이 단계는 시·고·저뿐', () => {
    // 거래량·거래대금·체결강도·어제보다는 같은 TR 에 있지만 wire 밖이라 범위 밖이다.
    const s = fillDayOhlcFromQuote(empty, { open: 458_500, high: 462_500, low: 424_500 });
    expect([s.cumVolume, s.cumValue, s.fillStrengthPct, s.vsPrevVolumePct]).toEqual([
      null, null, null, null,
    ]);
  });
});

describe('filterByVenueTag (거래원·프로그램)', () => {
  const frame = (venue: LiveFrameVenue | undefined, net: number) => ({ venue, net });

  it('선택 venue 의 프레임만 남긴다', () => {
    const input = [frame('KRX', 1), frame('NXT', 2), frame('UN', 3)];

    expect(filterByVenueTag(input, 'NXT').map((f) => f.net)).toEqual([2]);
    expect(filterByVenueTag(input, 'UN').map((f) => f.net)).toEqual([3]);
  });

  it('⚠ 회귀 가드 — 마지막 도착 프레임이 화면을 차지하면 안 된다', () => {
    // 이게 신고된 증상이다: 호버(스팟) 중엔 venue 별로 정상인데 벗어나면(LATEST)
    // 한 venue 로만 나왔다. 스팟은 파케이를 venue 별로 읽고 LATEST 는 WS 버퍼를
    // 쓰는데, 버퍼는 세 시장이 **시간순으로 섞여** 있어 마지막 프레임이 이긴다.
    const buffer = [frame('KRX', 1), frame('NXT', 2), frame('UN', 9)]; // UN 이 마지막

    expect(filterByVenueTag(buffer, 'KRX').map((f) => f.net)).toEqual([1]);
  });

  it('무태그(구백엔드)는 KRX 로 승격된다', () => {
    const input = [frame(undefined, 7)];

    expect(filterByVenueTag(input, 'KRX')).toHaveLength(1);
    expect(filterByVenueTag(input, 'NXT')).toHaveLength(0);
  });
})

describe('latestAfterHoursTotals', () => {
  const ah = (total_ask_qty: number, total_bid_qty: number, t_ms = 1) =>
    ({ t_ms, kind: 'ah', total_ask_qty, total_bid_qty });

  it('마지막 프레임의 총잔량을 준다', () => {
    expect(latestAfterHoursTotals([ah(100, 200, 1), ah(300, 400, 2)], null)).toEqual({
      ask: 300,
      bid: 400,
    });
  });

  it('버퍼가 비면 null — 정규장 총잔량으로 폴백하라는 뜻', () => {
    expect(latestAfterHoursTotals([], null)).toBeNull();
  });

  it('양쪽 0 은 null 로 접는다 — "시간외 잔량 없음"이 화면을 0 으로 덮지 않게', () => {
    expect(latestAfterHoursTotals([ah(0, 0)], null)).toBeNull();
  });

  it('한쪽만 0 은 유지한다 — 매수만 쌓인 시간외 호가는 정상 상태다', () => {
    expect(latestAfterHoursTotals([ah(0, 500)], null)).toEqual({ ask: 0, bid: 500 });
  });

  // ── 사다리와의 관계 (2026-08-19 실측) ──────────────────────────────────────
  //
  // 이 축이 없던 동안 **살아 있는 사다리 위에 멎은 0E 가 덮였다**: 08:53 실측에서
  // 005930(통합) 사다리는 08:53:59 로 실시간인데 스트립은 08:40:00 에 멎은 KRX
  // 시간외 값 23,870 을 "시간외" 라벨과 함께 그렸다(같은 순간 사다리 총잔량 13,938).
  // NXT 프리마켓과 KRX 장전 시간외 종가매매는 다른 시장의 다른 제도다.
  const OB_TS = 60_000_000;

  it('사다리가 살아 있으면 null — 덧씌우기는 멈춘 사다리에만 옳다', () => {
    // 0E 가 **더 최근이어도** 여유 안이면 사다리가 이긴다. 둘 다 살아 있는 구간
    // (NXT 프리마켓 08:00–08:50)에서 라벨이 깜빡이지 않게 하는 것이 이 여유다.
    expect(latestAfterHoursTotals([ah(300, 400, OB_TS + 1_000)], OB_TS)).toBeNull();
  });

  it('사다리가 멈췄으면 0E 가 이긴다 — 장후 15:40–16:00 의 유일한 호가 신호', () => {
    // 사다리 15:30 · 0E 15:40 → 10분 격차. 이 경로가 죽으면 KRX-only 종목은
    // 장후에 호가 축이 통째로 사라진다(0E 를 붙인 원래 이유).
    expect(latestAfterHoursTotals([ah(300, 400, OB_TS + 600_000)], OB_TS)).toEqual({
      ask: 300,
      bid: 400,
    });
  });

  it('여유 경계를 값으로 고정한다 — 미만은 사다리, 이상은 0E', () => {
    // 경계를 양쪽에서 집어야 실패 메시지가 "부호를 뒤집었다"와 "상수를 바꿨다"를
    // 구분해 준다. 한쪽만 두면 어느 실수인지 말해 주지 못한다.
    expect(latestAfterHoursTotals([ah(300, 400, OB_TS + 59_999)], OB_TS)).toBeNull();
    expect(latestAfterHoursTotals([ah(300, 400, OB_TS + 60_000)], OB_TS)).toEqual({
      ask: 300,
      bid: 400,
    });
  });

  it('사다리 시각을 모르면 덮지 않는다 — 모름은 안전한 쪽으로 실패해야 한다', () => {
    // `latestOrderbookSnapshot` 은 `ts_ms: latest.t_ms ?? 0` 이라 프레임에 t_ms 가
    // 없으면 0 이 실린다. 그 0 을 비교에 태우면 `ahTs - 0 >= 1분` 이 **항상 참**이라
    // 게이트가 조용히 열려 원래 혼입(살아 있는 사다리 위에 멎은 0E)이 돌아온다.
    // 사다리 없음(null)과 시각 미상(0)은 다른 상태다 — 아래 케이스와 짝으로 읽을 것.
    expect(latestAfterHoursTotals([ah(300, 400, OB_TS)], 0)).toBeNull();
  });

  it('사다리가 아예 없으면 여유와 무관하게 0E — 장전 08:30–08:40 KRX', () => {
    // 그날 첫 0D 가 오기 전이라 비교 대상 자체가 없다. 여기서 null 을 돌려주면
    // BookPanel 이 "호가 데이터 없음" 으로 떨어져 수신 중인 값이 화면에서 사라진다.
    expect(latestAfterHoursTotals([ah(22_367, 0, 1)], null)).toEqual({ ask: 22_367, bid: 0 });
  });
})

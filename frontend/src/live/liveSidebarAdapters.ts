import type {
  BrokerSeriesEntry,
  BrokerSeriesPoint,
  OrderbookLevel,
  OrderbookSnapshot,
  ProgramTradePoint,
  ProgramTradeSeries,
} from '../api/types';
import { isContinuousBook, type ObSnapshot, type TradeSnapshot } from './bucketHogaSeries';
import { liveVenueAcceptsFrame, type LiveFrameVenue } from './liveVenuePolicy';
import type { LiveVenueOption } from '../state/liveVenue';

type RawSnapshot = Record<string, unknown>;

/**
 * 선택 venue로 라이브 `ob` 버퍼를 거른다 — 표시 버퍼는 전역·혼재(전달 무게이트,
 * stream.py §11)이므로 per-user venue 선택을 강제할 수 있는 유일 지점이다. 깜빡임의
 * 근원(두 시장 프레임 교대)도 여기서 끊긴다. 판정은 정책 SSOT 술어
 * `liveVenueAcceptsFrame`(프레임 자기 t_ms 기준)에 위임 — latest·cursor·delta 소비자
 * 모두에 올바르다.
 */
export function filterObByVenue(
  ob: readonly ObSnapshot[],
  selectedVenue: LiveVenueOption,
): readonly ObSnapshot[] {
  return ob.filter((f) => liveVenueAcceptsFrame(selectedVenue, f.venue));
}

/**
 * 선택 venue로 라이브 `trade` 버퍼를 거른다 — `filterObByVenue`(호가)의 체결
 * 대응물이자 같은 SSOT 술어(`liveVenueAcceptsFrame`)를 공유한다. 표시 버퍼는 전역·
 * 혼재(전달 무게이트)이므로 체결창·체결강도·체결 미니리스트가 per-user venue 선택을
 * 강제할 수 있는 유일 지점이다. 호가만 걸러지고 체결은 KRX+NXT가 섞여 보이던
 * 불일치(execution-window-datasource-policy)를 여기서 끊는다.
 */
export function filterTradeByVenue(
  trade: readonly TradeSnapshot[],
  selectedVenue: LiveVenueOption,
): readonly TradeSnapshot[] {
  return trade.filter((f) => liveVenueAcceptsFrame(selectedVenue, f.venue));
}

/**
 * 선택 venue로 라이브 `broker`·`program` 버퍼를 거른다 — 호가·체결 필터의 나머지 둘.
 *
 * ⚠ **이 둘만 빠져 있었다.** `ob`·`trade` 는 소스에서 걸러졌는데 `broker`·`program`
 * 은 버퍼에서 그대로 나갔다. 프레임엔 venue 태그가 실려 있었고(`stream.on_tick` 이
 * `payload["venue"]` 를 박는다) 읽는 쪽만 안 봤다.
 *
 * 증상이 특이했다 — **호버(스팟) 중엔 정상, 벗어나면(LATEST) 한 venue 로만** 나왔다.
 * 스팟은 파케이를 venue 별로 읽지만(`useLiveBrokersToday`), LATEST 는 WS 버퍼를 쓰기
 * 때문이다. 버퍼는 세 시장이 시간순으로 섞여 있어 **마지막에 도착한 프레임의 venue**
 * 가 화면을 차지한다. 값이 그럴듯해 "가끔 이상한 값" 으로만 보인다.
 *
 * 페이로드 모양이 kind 마다 달라 제네릭으로 둔다 — 판정은 `venue` 태그 하나뿐이다.
 */
export function filterByVenueTag<T extends { venue?: LiveFrameVenue }>(
  frames: readonly T[],
  selectedVenue: LiveVenueOption,
): readonly T[] {
  return frames.filter((f) => liveVenueAcceptsFrame(selectedVenue, f.venue));
}

const EMPTY_LEVEL: OrderbookLevel = { price: 0, qty: 0 };

function padLevels(levels: unknown): OrderbookLevel[] {
  const arr = Array.isArray(levels) ? levels : [];
  const out: OrderbookLevel[] = [];
  for (let i = 0; i < 10; i++) {
    const entry = arr[i] as { price?: number; qty?: number } | undefined;
    if (entry && typeof entry.price === 'number' && typeof entry.qty === 'number') {
      out.push({ price: entry.price, qty: entry.qty });
    } else {
      out.push(EMPTY_LEVEL);
    }
  }
  return out;
}

/**
 * Project the latest `ob` snapshot from the live buffer into the
 * OrderbookSnapshot shape that BookPanel consumes (via DataWindow).
 *
 * Returns null if the buffer is empty. Callers should treat that as
 * "data not yet arrived" and render the empty state. Missing or short
 * `asks`/`bids` arrays are zero-padded to length 10 so the table layout
 * stays stable.
 */
export function latestOrderbookSnapshot(ob: readonly RawSnapshot[]): OrderbookSnapshot | null {
  if (ob.length === 0) return null;
  const latest = ob[ob.length - 1];
  return {
    ts_ms: (latest.t_ms as number) ?? 0,
    seq: 0, // live snapshots don't carry seq — sidebar reads ts_ms anyway
    ask: padLevels(latest.asks),
    bid: padLevels(latest.bids),
    tot_ask: (latest.total_ask_qty as number) ?? 0,
    tot_bid: (latest.total_bid_qty as number) ?? 0,
    exp_price: (latest.expected_price as number) ?? 0,
    exp_qty: (latest.expected_qty as number) ?? 0,
  };
}

/** 시간외 매도/매수 총잔량(키움 0E). 정규장 총잔량과 **다른 값**이다. */
/** 총**잔량** 두 개. 이름 그대로 잔량만 담는다.
 *
 *  `volume`(누적 체결량) 필드가 있었는데 **제거했다**(2026-08-19). 체결량은 축이
 *  다른 숫자이고, 여기 얹혀 있던 이유는 "시간외에는 개별 체결 내역이 없어 이 누적이
 *  유일한 체결 신호" 였다. #1417 이 체결창에 주기별 행을 그리면서 그 전제가 사라졌다.
 *  다시 넣고 싶어지면 그 자리가 정말 잔량 스트립인지부터 물을 것. */
export type AfterHoursTotals = {
  ask: number;
  bid: number;
};

/** 0E 가 사다리를 덧씌우려면 사다리보다 이만큼 앞서야 한다.
 *
 *  **왜 여유가 필요한가**: 두 스트림이 **둘 다 살아 있는** 구간이 있다. NXT 프리마켓
 *  (08:00–08:50 접속매매)이 그것으로, 그때 사다리는 초당 여러 건 갱신되고 0E 도
 *  08:30–08:40 에 5초 주기로 온다. 단순히 `ahTs > obTs` 로 가르면 0E 가 막 도착한
 *  찰나에만 이겨서 **라벨이 깜빡인다**. 반대로 진짜 덧씌워야 하는 구간의 격차는
 *  분 단위다(장후: 사다리 15:30 · 0E 15:40~16:00). 그 사이 어디를 잘라도 판정이
 *  같으므로 넉넉한 1분을 쓴다 — 이 값은 정밀도가 아니라 **안정성**을 사는 것이다. */
const AFTER_HOURS_OVERRIDE_MARGIN_MS = 60_000;

/**
 * 시간외호가 버퍼(`ah`)의 마지막 총잔량. 없거나 **사다리가 더 최신이면** null.
 *
 * `latestOrderbookSnapshot` 과 짝이지만 `OrderbookSnapshot` 을 만들지 **않는다** —
 * 0E 에는 사다리가 없어서 만들면 10단이 전부 0 인 가짜 호가창이 된다
 * (백엔드 `SnapshotKind.AFTER_HOURS` 주석). 소비자는 이 값을 정규장 스냅샷의
 * 총잔량 **자리에 덧씌우되**, 사다리는 정규장 마지막 값 그대로 두고 라벨로
 * 두 출처를 구분해야 한다.
 *
 * 양쪽 0 은 null 로 접는다 — 파서가 이미 그런 프레임을 버리지만(`_parse_after_hours`),
 * 여기서도 접어야 "시간외 잔량 없음" 이 정규장 총잔량으로 자연히 폴백한다.
 *
 * ## `obTsMs` — 덧씌우기는 **사다리가 멈춰 있을 때만** 옳다
 *
 * 이 함수엔 원래 시계 게이트가 없었다. 의도적이었다 — 장후엔 0E 가 유일한 호가
 * 신호라 창을 좁히면 진짜 신호가 죽는다. 그런데 그 설계는 **"사다리는 멈춰 있다"**
 * 를 암묵 전제로 깔고 있었고(15:30 에 0D 가 끊긴 뒤가 유일한 관측 구간이었다),
 * 사다리가 **살아 있는** 구간이 존재한다는 사실이 빠져 있었다.
 *
 * 2026-08-19 08:53 실측(005930, 통합): 사다리는 08:53:59 로 실시간인데 스트립은
 * **08:40:00 에 멎은 0E 값**(23,870)을 "시간외" 라벨과 함께 그리고 있었다 — 같은
 * 순간 사다리 총잔량은 13,938 이었다. NXT 프리마켓과 KRX 장전 시간외 종가매매는
 * **다른 시장의 다른 제도**인데 한 패널에서 섞인 것이다. 0E 는 `KRX` 뿐 아니라
 * `UN` 태그로도 오므로(같은 실측에서 확인 — 파서 주석의 "미실측" 이 풀렸다)
 * venue 필터가 이걸 걸러 주지 않는다.
 *
 * 그래서 판정을 **프레임 t_ms** 로 한다(벽시계가 아니다 — 벽시계 게이트는 창을
 * 잘못 좁혀 진짜 신호를 죽이는 쪽으로 실패한다):
 *
 *   - `obTsMs === null` — 사다리가 아예 없다. 0E 가 유일한 신호다(장전 08:30–08:40
 *     KRX 가 그 상태). **덧씌우는 게 아니라 그것만 그린다** — BookPanel 축약 분기.
 *   - `ahTs - obTsMs >= 1분` — 사다리가 멈췄고 0E 가 현재값이다(장후 15:40–16:00).
 *   - 그 외 — 사다리가 살아 있다. **사다리 총잔량이 정답이므로 null 을 돌려준다.**
 *
 * **"사다리는 있는데 시각을 모른다" 는 덮지 않는 쪽으로 실패한다.** `latestOrderbookSnapshot`
 * 은 `ts_ms: latest.t_ms ?? 0` 으로 만들므로 프레임에 `t_ms` 가 없으면 0 이 실린다.
 * 그 0 을 그대로 비교에 태우면 `ahTs - 0 >= 1분` 이 **항상 참**이라 게이트가 조용히
 * 열려 원래 혼입이 돌아온다 — 모름이 "덮는다" 로 귀결되는 것은 실패 방향이 거꾸로다.
 * 사다리 없음(`null`)과 시각 미상(`0`)은 **다른 상태**이고, 후자는 사다리를 신뢰한다.
 */
export function latestAfterHoursTotals(
  ah: readonly RawSnapshot[],
  obTsMs: number | null,
): AfterHoursTotals | null {
  if (ah.length === 0) return null;
  const latest = ah[ah.length - 1];
  const ask = (latest.total_ask_qty as number) ?? 0;
  const bid = (latest.total_bid_qty as number) ?? 0;
  if (ask === 0 && bid === 0) return null;
  if (obTsMs !== null) {
    // 시각 미상(0·음수)이면 비교를 포기하고 사다리를 신뢰한다 — 위 docstring 의
    // 실패 방향 규약. `ahTs` 가 0 인 경우도 이 부등식이 자연히 흡수한다.
    if (obTsMs <= 0) return null;
    const ahTs = (latest.t_ms as number) ?? 0;
    if (ahTs - obTsMs < AFTER_HOURS_OVERRIDE_MARGIN_MS) return null;
  }
  return { ask, bid };
}

/** 종목 요약 지표 — 0B 프레임 payload 최상위에 실려 오는 값들(kiwoom_frames._parse_trade).
 *  체결 레코드가 아니라 종목 단위 값이라 trades[] 안이 아니라 payload 루트에 있다. */
export type LiveTradeSummary = {
  fillStrengthPct: number | null; // FID 228
  vsPrevVolumePct: number | null; // FID 30 — 오늘 누적 ÷ 전일 전량 × 100
  cumVolume: number | null;       // FID 13
  cumValue: number | null;        // FID 14 — 파서가 원 단위로 정규화
  dayOpen: number | null;         // FID 16
  dayHigh: number | null;         // FID 17
  dayLow: number | null;          // FID 18
  prevClose: number | null;       // FID 10 − 11 로 유도
};

export const EMPTY_TRADE_SUMMARY: LiveTradeSummary = {
  fillStrengthPct: null, vsPrevVolumePct: null, cumVolume: null, cumValue: null,
  dayOpen: null, dayHigh: null, dayLow: null, prevClose: null,
};

function positive(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 라이브 체결 버퍼에서 종목 요약 지표를 뽑는다.
 *
 * **최신 1건이 아니라 뒤에서부터 훑는 이유**: 파서는 미수신/0 인 필드의 키를 아예
 * 싣지 않는다(day_open 과 동일 규약 — "미수신"과 "진짜 0"을 소비자가 구분하지
 * 않아도 되게). 그래서 가장 최근 프레임에 특정 키가 없을 수 있고, 그때는 직전
 * 프레임의 값이 여전히 유효하다. 키별로 독립적으로 "가장 최근에 관측된 값"을 잡는다.
 *
 * 전 필드를 채웠으면 조기 종료한다 — 버퍼는 수천 건까지 자랄 수 있다.
 */
export function latestTradeSummary(trade: readonly RawSnapshot[]): LiveTradeSummary {
  if (trade.length === 0) return EMPTY_TRADE_SUMMARY;
  const out: LiveTradeSummary = { ...EMPTY_TRADE_SUMMARY };
  const fields: [keyof LiveTradeSummary, string][] = [
    ['fillStrengthPct', 'fill_strength_pct'],
    ['vsPrevVolumePct', 'vs_prev_volume_pct'],
    ['cumVolume', 'cum_volume'],
    ['cumValue', 'cum_value'],
    ['dayOpen', 'day_open'],
    ['dayHigh', 'day_high'],
    ['dayLow', 'day_low'],
    ['prevClose', 'prev_close'],
  ];
  let remaining = fields.length;
  for (let i = trade.length - 1; i >= 0 && remaining > 0; i--) {
    const entry = trade[i];
    for (const [key, wire] of fields) {
      if (out[key] !== null) continue;
      const v = positive(entry[wire]);
      if (v !== null) { out[key] = v; remaining--; }
    }
  }
  return out;
}

/** 이 폴백이 읽는 `LiveQuote` 의 부분집합. 전체 타입을 끌어오지 않는 이유는 그쪽이
 *  react-query 훅 모듈이고, 어댑터는 조회 수단을 몰라야 하기 때문이다.
 *
 *  키 이름이 wire 그대로인 것은 의도다 — 미러 대조가 눈으로 되게. */
export type QuoteTradeSummary = {
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
  trade_value?: number | null;
  vs_prev_volume_pct?: number | null;
  fill_strength_pct?: number | null;
};

/**
 * 요약 키 → 시세 오버레이 키. **한 표가 폴백 대상의 정본이다.**
 *
 * 채우기와 "아무것도 안 채웠나" 판정을 **같은 표에서** 뽑는다. 손으로 쓴 비교식과
 * 병행하면 필드를 늘릴 때 한쪽만 늘어나 조기 반환이 새 필드를 삼키는데, 그건 가장
 * 흔한 설정에서만 무효라 기존 테스트가 전부 통과한다 — 표 하나면 원리적으로 없다.
 *
 * `prevClose` 는 **일부러 뺐다**: 이 패널은 전일종가를 `baselinePrice` prop 으로 따로
 * 받고(커서 날짜를 따라간다), 요약의 그 칸은 어떤 소비처도 읽지 않는다.
 */
const QUOTE_SUMMARY_FALLBACK: readonly (readonly [
  keyof LiveTradeSummary,
  keyof QuoteTradeSummary,
])[] = [
  ['dayOpen', 'open'],
  ['dayHigh', 'high'],
  ['dayLow', 'low'],
  ['cumVolume', 'volume'],
  ['cumValue', 'trade_value'],
  ['vsPrevVolumePct', 'vs_prev_volume_pct'],
  ['fillStrengthPct', 'fill_strength_pct'],
];

/**
 * 당일 요약을 시세 오버레이로 메운다 — `latestTradeSummary` 의 **결손 보충**이다.
 *
 * 위 함수의 유일한 출처인 WS `0B` 는 15:30 에 끊기고, 표시 링버퍼는 보존이 15분이다.
 * 그래서 마감 후 **새로 연 탭**에서는 요약이 전 칸 대시가 된다(이미 열려 있던 탭은
 * 화석을 계속 그린다 — 프론트 축출은 들어온 프레임 기준이라 멎으면 함께 멎는다).
 * 사다리는 `LiveBuffer._last_ob` 사이드카가 디스크까지 살려 두므로, 결과는 "사다리는
 * 멀쩡한데 요약만 빈" 반쪽 화면이다(사용자 보고 2026-08-31).
 *
 * **새 조회를 만들지 않는다.** `/api/live/quotes`(키움 `ka10095`)는 이 창이 등락률
 * 분모로 이미 폴링하고 있고, 같은 응답에 일곱 칸이 전부 실려 온다.
 *
 * 왜 **필드별** 폴백인가: `latestTradeSummary` 자체가 키별로 독립해 "가장 최근에
 * 관측된 값" 을 잡는 규약이다. 그 규약을 이어받으면 **시각 판정이 필요 없다** —
 * 장중엔 `0B` 가 값을 들고 있어 폴백이 저절로 no-op 이고, 마감 후엔 저절로 발화한다.
 * 시계로 갈랐다면 경계마다 두 출처가 다투는 자리를 새로 만들었을 것이다.
 *
 * ⚠ `positive` 를 통과시키는 것이 필수다. 벤더 파서(`kiwoom_multi_quote._abs_int`)는
 * `"0"` 을 **0 으로 통과시킨다** — 첫 체결 전 종목이 그렇게 온다. 그대로 실으면
 * 요약이 대시 대신 "0" 을 그리고, 사다리 칩 판정(`offLadderChip`)까지 0 을 가격으로
 * 다룬다. "미제공" 과 "진짜 0" 을 여기서 갈라 놔야 그 아래가 전부 종전 규약이다.
 *
 * ⚠ 장전(pre_open)은 백엔드가 이 일곱 필드를 통째로 `None` 으로 지운다
 * (`_to_live_quote`) — 어제 값이 오늘 아침 화면에 새는 경로가 원천에서 막혀 있어
 * 여기서 날짜를 다시 재지 않는다.
 *
 * 아무것도 안 메웠으면 **입력을 그대로 돌려준다.** 리렌더 절감이 목적이 아니다 —
 * 그 판단은 호출부 useMemo 가 이미 하고, 버퍼가 차 있으면 `latestTradeSummary` 가
 * 어차피 매 호출 새 객체를 만든다. 목적은 **"폴백이 발화하지 않았다" 를 참조 동일성
 * 으로 관측 가능하게** 두는 것이고, 빈 버퍼의 `EMPTY_TRADE_SUMMARY` 싱글턴이 이
 * 함수를 지나도 싱글턴으로 남는다는 성질이 거기서 따라온다.
 */
export function fillTradeSummaryFromQuote(
  summary: LiveTradeSummary,
  quote: QuoteTradeSummary | null | undefined,
): LiveTradeSummary {
  if (quote == null) return summary;
  let out: LiveTradeSummary | null = null;
  for (const [key, wire] of QUOTE_SUMMARY_FALLBACK) {
    if (summary[key] !== null) continue;
    const v = positive(quote[wire]);
    if (v === null) continue;
    out ??= { ...summary };
    out[key] = v;
  }
  return out ?? summary;
}

/**
 * ADR-0044 amendment (2026-06-11) — derive the bucket-representative orderbook
 * snapshot for `cursorMs` from the in-memory SSE buffer (`live.ob`), CLIENT-SIDE.
 *
 * Why: promoted parquet lags the live edge by ~2–5 min (Today Promotion cadence,
 * ADR-0043), so hovering a recent candle made the parquet spot path (ADR-0044)
 * return null → an empty sidebar (the reported bug). The SSE buffer already
 * holds the last ~15 min of books (RETENTION_MS, liveSnapshotBuffer.ts), which
 * covers that lag. LiveSidebar tries the parquet spot FIRST and only falls back
 * here when it has nothing for the bucket — so parquet stays authoritative and
 * the two sources never answer for the same time (defusing ADR-0044 alt-C's
 * "which one is real?" objection). The hover FETCHER stays parquet-only; this
 * fallback is composed at the LiveSidebar layer (ADR-0044 invariant intact).
 *
 * Bucket-representative semantics MATCH the backend `query_bucket_representative`
 * (routes.py): the last *continuous-trading* book in [bucketStart,
 * bucketStart + bucketMs) — closing-auction 3-level books excluded via
 * `isContinuousBook` — with bucketStart = floor(cursorMs / bucketMs) * bucketMs
 * (the candle-start convention the cursor's `alignedT` already uses). Falls back
 * to the last book in the bucket if none is structurally continuous (matches the
 * backend's representative pick on totals-only frames). Returns null when no book
 * sits in that bucket (cursor outside the buffer window = a genuine gap → caller
 * keeps the empty state + "다음 가용" hint, preserving ADR-0044 there).
 *
 * Assumes `ob` is ascending by t_ms (the buffer maintains arrival order).
 */
export function orderbookSnapshotAtCursor(
  ob: readonly ObSnapshot[],
  cursorMs: number,
  bucketMs: number,
): OrderbookSnapshot | null {
  const lo = Math.floor(cursorMs / bucketMs) * bucketMs;
  const hi = lo + bucketMs; // [lo, hi)
  let continuous: ObSnapshot | null = null;
  let anyBook: ObSnapshot | null = null;
  for (const s of ob) {
    if (s.t_ms < lo || s.t_ms >= hi) continue;
    if (!s.asks && !s.bids) continue; // need a real book to render
    anyBook = s; // last book in bucket (ascending → overwrite keeps the latest)
    if (isContinuousBook(s)) continuous = s;
  }
  const pick = continuous ?? anyBook;
  if (pick === null) return null;
  return {
    ts_ms: pick.t_ms,
    seq: 0,
    ask: padLevels(pick.asks),
    bid: padLevels(pick.bids),
    tot_ask: pick.total_ask_qty ?? 0,
    tot_bid: pick.total_bid_qty ?? 0,
    exp_price: pick.expected_price ?? 0,
    exp_qty: pick.expected_qty ?? 0,
  };
}

/**
 * Walk all broker snapshots in the live buffer, accumulating signed-net
 * time series per broker. Buy-side brokers contribute positive net;
 * sell-side contribute negative net. Returns BrokerSeriesEntry[] sorted
 * by final_net desc and includes all recorded broker identities —
 * matches the wire shape BrokerTrajectoryTable expects (ADR-0023).
 *
 * Note: live broker snapshots are per-cycle top-5 lists, so the same
 * broker may drop in and out of the top-5 across snapshots. The
 * resulting series has gaps wherever a broker fell off the list — that
 * matches how /replay treats broker data and is intentional per ADR-0023.
 */
/**
 * ADR-0044 amendment (2026-07-21) — latest 모드 거래원 궤적을 "승격된 당일
 * 파케이 + 미승격 WS 꼬리" 로 잇는다. CLIENT-SIDE 합성이며 fetcher 는
 * parquet-only 그대로다(위 orderbookSnapshotAtCursor 와 동일 구조).
 *
 * Why: 2026-07-09 개정이 빈영역 hover 를 latest 로 돌리면서 매물대는 "latest =
 * 전체 누적" 을 얻었지만 거래원은 못 얻었다. latest 경로가
 * aggregateBrokerSeries(live.broker) 하나였고 그 버퍼는 15분 슬라이딩이라,
 * 하루 폭으로 고정된 x축 위에 최근 15분 궤적만 얹혀 그려졌다(사용자 보고:
 * "당일 누적으로 나와야 하는데 짧은 선만 나옴"). 우측 숫자는 키움 0F 값 자체가
 * 당일 누적이라 맞고 궤적만 잘려, 숫자와 그림이 어긋나는 비대칭이 생겼다.
 *
 * 이음매 = **전역 최대 파케이 ts**(브로커별이 아니라). 프로모터는 전 브로커를
 * 한 번에 쓰므로 승격 경계는 전역이다. 브로커별 마지막 ts 로 자르면, 그 브로커가
 * top-5 밖이라 파케이가 정직하게 비워둔 구간을 WS 점으로 메워 "연속 관측" 을
 * 날조하게 된다(ADR-0023 top-5 절단 정직성).
 *
 * 두 소스는 시간대를 공유하지 않는다 — parquet 은 승격된 과거, 버퍼는 미승격
 * 꼬리. 2026-06-11 개정이 무력화한 "어느 게 진짜?" 반론이 여기서도 그대로 성립.
 * 밀도가 다르므로(파케이=10초 다운샘플, 버퍼=원시 틱) 겹치는 구간을 양쪽에서
 * 그리면 안 되고, 이음매 초과분만 이어붙인다.
 *
 * 사이징 근거: 프로모터 지연 ≤ 10s(다운샘플 윈도) + 300s(승격 주기) ≈ 5분 10초 <
 * RETENTION_MS(15분). 리페치 주기를 얹어도 여유가 크다.
 */
/** 파케이 본체를 **파케이 배열 정체성당 1회만** 준비해 둔 결과.
 *
 *  호출부(DataWindow)의 memo deps 는 `[todaySeries, liveTail]` 인데 `liveTail` 은
 *  브로커 WS 푸시마다 새 참조라, 이 함수는 **틱마다** 돈다. 반면 파케이는 60초
 *  리페치 주기로만 바뀐다. 종전엔 매 틱 전 브로커의 전 포인트를 복사하고
 *  브로커마다 정렬까지 했다 — 그 비용이 당일 궤적 길이에 비례하니 장이 진행될수록
 *  무거워졌다(09:00 엔 공짜, 15:00 엔 브로커당 수천 점 × 초당 수 회).
 *
 *  `points` 배열은 **우리가 만든 사본**이다 — 호출부가 넘긴 배열을 그대로 들고
 *  있지 않으므로, 아래에서 이 배열을 결과에 재사용해도 입력을 별칭하지 않는다
 *  (입력 불변 계약 유지). */
type PreparedBrokerParquet = {
  seamMs: number;
  byBroker: Map<string, BrokerSeriesPoint[]>;
};

/** 파케이 배열 참조를 키로 준비 결과를 캐시한다. WeakMap 이라 파케이가 교체되면
 *  이전 준비물은 저절로 회수된다(누적 없음). */
const preparedBrokerParquet = new WeakMap<
  readonly BrokerSeriesEntry[],
  PreparedBrokerParquet
>();

function prepareBrokerParquet(
  parquet: readonly BrokerSeriesEntry[],
): PreparedBrokerParquet {
  const hit = preparedBrokerParquet.get(parquet);
  if (hit) return hit;

  // 전역 이음매 — 승격된 마지막 관측 시각.
  let seamMs = -Infinity;
  for (const e of parquet) {
    const last = e.points[e.points.length - 1];
    if (last && last.ts_ms > seamMs) seamMs = last.ts_ms;
  }
  const byBroker = new Map<string, BrokerSeriesPoint[]>();
  for (const e of parquet) byBroker.set(e.broker, [...e.points]);

  const prepared = { seamMs, byBroker };
  preparedBrokerParquet.set(parquet, prepared);
  return prepared;
}

export function mergeBrokerSeriesWithLiveTail(
  parquetSeries: readonly BrokerSeriesEntry[] | null | undefined,
  liveSeries: readonly BrokerSeriesEntry[],
): BrokerSeriesEntry[] {
  const parquet = parquetSeries ?? [];
  if (parquet.length === 0) return liveSeries.map(cloneEntry);

  const { seamMs, byBroker: base } = prepareBrokerParquet(parquet);

  // 브로커별 최종 포인트 배열. 꼬리가 없는 브로커는 준비된 사본을 **그대로 재사용**
  // 한다 — 틱마다 새 점이 붙는 브로커는 보통 소수라, 여기서 대부분의 할당이 사라진다.
  const merged = new Map<string, BrokerSeriesPoint[]>(base);
  for (const e of liveSeries) {
    const tail = e.points.filter((p) => p.ts_ms > seamMs);
    if (tail.length === 0) {
      // 꼬리가 없고 파케이에도 없는 브로커는 **빈 엔트리로 남긴다** — 종전 동작
      // 보존이다. 이 함수 변경은 순수 성능 작업이므로 출력이 달라지면 안 된다.
      if (!merged.has(e.broker)) merged.set(e.broker, []);
      continue;
    }
    const head = base.get(e.broker);
    // concat 은 입력을 변형하지 않는다 — 준비된 사본은 다음 틱에도 온전해야 한다.
    merged.set(e.broker, head ? head.concat(tail) : tail.slice());
  }

  const entries: BrokerSeriesEntry[] = [];
  for (const [broker, points] of merged) {
    // 정렬하지 않는다. 파케이는 ts_ms 오름차순이 타입 계약이고(BrokerSeriesEntry),
    // 꼬리는 전부 seamMs(= 파케이 전역 최대 ts) **초과**라 어느 브로커에서든
    // 파케이 구간 뒤에 온다. 이어붙이면 오름차순이 보존되므로 매 틱 O(n log n)
    // 재정렬은 순수 낭비였다.
    const finalNet = points.length > 0 ? points[points.length - 1].net : 0;
    entries.push({
      broker,
      final_net: finalNet,
      dominant_side: finalNet >= 0 ? 'buy' : 'sell',
      points,
    });
  }
  entries.sort((a, b) => b.final_net - a.final_net);
  return entries;
}

function cloneEntry(e: BrokerSeriesEntry): BrokerSeriesEntry {
  return { ...e, points: [...e.points] };
}

export function aggregateBrokerSeries(broker: readonly RawSnapshot[]): BrokerSeriesEntry[] {
  const byBroker = new Map<string, BrokerSeriesPoint[]>();

  for (const snap of broker) {
    const ts = (snap.t_ms as number) ?? 0;
    const buys = (snap.buy_top as Array<{ name: string; qty: number }>) ?? [];
    const sells = (snap.sell_top as Array<{ name: string; qty: number }>) ?? [];
    // Sum buy and sell qty per broker within this snapshot so a market-maker
    // appearing on both top-5 lists collapses to one signed point (matches
    // backend query_day_series; see CONTEXT.md "Broker Day-Trajectory").
    const perSnap = new Map<string, number>();
    for (const b of buys) {
      if (typeof b?.name !== 'string') continue;
      perSnap.set(b.name, (perSnap.get(b.name) ?? 0) + (b.qty ?? 0));
    }
    for (const s of sells) {
      if (typeof s?.name !== 'string') continue;
      perSnap.set(s.name, (perSnap.get(s.name) ?? 0) - (s.qty ?? 0));
    }
    for (const [name, net] of perSnap) {
      const pts = byBroker.get(name) ?? [];
      pts.push({ ts_ms: ts, net });
      byBroker.set(name, pts);
    }
  }

  const entries: BrokerSeriesEntry[] = [];
  for (const [name, points] of byBroker.entries()) {
    points.sort((a, b) => a.ts_ms - b.ts_ms);
    const finalNet = points.length > 0 ? points[points.length - 1].net : 0;
    entries.push({
      broker: name,
      final_net: finalNet,
      dominant_side: finalNet >= 0 ? 'buy' : 'sell',
      points,
    });
  }

  entries.sort((a, b) => b.final_net - a.final_net);
  return entries;
}

/**
 * WS `program`(0w) 원본 스냅샷을 ProgramTradePoint[] 로 집계한다. 백엔드
 * kiwoom_frames._parse_program payload({t_ms, net_qty, net_amount, …})가 프론트
 * point 필드와 1:1 대응이라, t_ms→t 리네이밍과 gap_risk=false(실시간 관측이므로
 * 공백이 아님)만 붙이면 된다. delta_qty/delta_amount 는 카드가 소비하지 않고
 * (파생값은 저장 경로 collector 의 flush-간 diff 몫), 실시간 꼬리엔 원래 없는
 * 필드라 채우지 않는다. t_ms 오름차순은 버퍼(append-only)가 보장한다.
 */
export function aggregateProgramTrade(
  program: readonly RawSnapshot[],
): ProgramTradePoint[] {
  const out: ProgramTradePoint[] = [];
  for (const snap of program) {
    const t = snap.t_ms;
    if (typeof t !== 'number') continue;
    const netQty = snap.net_qty;
    const netAmount = snap.net_amount;
    out.push({
      t,
      net_qty: typeof netQty === 'number' ? netQty : null,
      net_amount: typeof netAmount === 'number' ? netAmount : null,
      gap_risk: false,
    });
  }
  return out;
}

/**
 * 프로그램 순매수 REST 본체(/api/range 번들, 5분 주기)에 WS 실시간 꼬리를 잇는다 —
 * mergeBrokerSeriesWithLiveTail 의 단일-배열 판(프로그램은 종목당 단일 시리즈라
 * broker 의 broker별 Map/seam 이 불필요하다). 이음매(seam)는 본체 마지막 관측 t,
 * 그 이후의 tail 만 이어붙여 중복을 없앤다. 본체가 비면 tail 전체를 쓴다.
 *
 * 사이징 근거는 broker 와 동일: 수집기 drain(30초) + 번들 리페치(5분) 지연을
 * WS 버퍼(15분 RETENTION_MS)가 여유 있게 덮어 이음매에 구멍이 없다.
 *
 * tail 이 비면 본체 원본을 그대로 반환한다 — 참조 안정성을 지켜 소비처 memo 가
 * 유지되도록(장 시작 전·재접속 직후 버퍼가 빈 흔한 경우).
 */
export function mergeProgramTradeWithLiveTail(
  parquet: ProgramTradeSeries | null | undefined,
  liveTail: readonly ProgramTradePoint[],
): ProgramTradeSeries {
  const base = parquet?.points ?? [];
  if (base.length === 0) return { points: [...liveTail], source: parquet?.source };

  let seamMs = -Infinity;
  for (const p of base) if (p.t > seamMs) seamMs = p.t;
  const tail = liveTail.filter((p) => p.t > seamMs);
  if (tail.length === 0) return parquet ?? { points: [...base] };
  return { points: [...base, ...tail], source: parquet?.source };
}

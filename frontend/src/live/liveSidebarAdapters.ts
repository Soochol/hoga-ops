import type {
  BrokerSeriesEntry,
  BrokerSeriesPoint,
  OrderbookLevel,
  OrderbookSnapshot,
} from '../api/types';
import { isContinuousBook, type ObSnapshot, type TradeSnapshot } from './bucketHogaSeries';
import { liveVenueAcceptsFrame } from './liveVenuePolicy';
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
  return ob.filter((f) => liveVenueAcceptsFrame(selectedVenue, f.venue, f.t_ms));
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
  return trade.filter((f) => liveVenueAcceptsFrame(selectedVenue, f.venue, f.t_ms));
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
 * OrderbookSnapshot shape that OrderbookTable / TotalQtyBar consume.
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
export function mergeBrokerSeriesWithLiveTail(
  parquetSeries: readonly BrokerSeriesEntry[] | null | undefined,
  liveSeries: readonly BrokerSeriesEntry[],
): BrokerSeriesEntry[] {
  const parquet = parquetSeries ?? [];
  if (parquet.length === 0) return liveSeries.map(cloneEntry);

  // 전역 이음매 — 승격된 마지막 관측 시각.
  let seamMs = -Infinity;
  for (const e of parquet) {
    const last = e.points[e.points.length - 1];
    if (last && last.ts_ms > seamMs) seamMs = last.ts_ms;
  }

  const byBroker = new Map<string, BrokerSeriesPoint[]>();
  for (const e of parquet) byBroker.set(e.broker, [...e.points]);
  for (const e of liveSeries) {
    const tail = e.points.filter((p) => p.ts_ms > seamMs);
    if (tail.length === 0 && byBroker.has(e.broker)) continue;
    const merged = byBroker.get(e.broker) ?? [];
    merged.push(...tail);
    byBroker.set(e.broker, merged);
  }

  const entries: BrokerSeriesEntry[] = [];
  for (const [broker, points] of byBroker) {
    points.sort((a, b) => a.ts_ms - b.ts_ms);
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

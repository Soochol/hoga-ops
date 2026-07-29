import type {
  BrokerSeriesEntry,
  BrokerSeriesPoint,
  OrderbookLevel,
  OrderbookSnapshot,
  ProgramTradePoint,
  ProgramTradeSeries,
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import { subscribeLive } from './ws';
import type { LiveSnapshotEntry } from './types';
import type { AskPeakCandidate } from './types';
import { LiveSnapshotBuffer, type SnapshotKind } from '../live/liveSnapshotBuffer';
import type { ObSnapshot, TradeSnapshot } from '../live/bucketHogaSeries';
import { filterByVenueTag, filterObByVenue, filterTradeByVenue } from '../live/liveSidebarAdapters';
import { useEffectiveVenue } from '../live/useEffectiveVenue';
import type { LiveVenueOption } from '../state/liveVenue';
import { unixMsToKSTDate } from '../util/time';

export type LiveTodayPeakBase = {
  date: string;
  coverage: 'full' | 'partial';
  traded_prices: number[];
  traded_price: number | null;
  traded_qty: number | null;
  traded_t_ms: number | null;
  traded_peaks?: AskPeakCandidate[];
  untraded_price?: number | null;
  untraded_qty?: number | null;
  untraded_t_ms?: number | null;
  untraded_max_price?: number | null;
  untraded_max_qty?: number | null;
  untraded_max_t_ms?: number | null;
  untraded_peaks?: AskPeakCandidate[];
  untraded_max_peaks?: AskPeakCandidate[];
  all_price: number;
  all_qty: number;
  all_t_ms: number;
};

export type LiveTodayAskPeak = LiveTodayPeakBase & {
  all_peaks?: AskPeakCandidate[];
};

export type LiveTodayBidPeak = LiveTodayPeakBase & {
  all_peaks?: AskPeakCandidate[];
};

export interface LiveSeriesResponse {
  code: string;
  date: string;
  session_open_ms: number;
  session_close_ms: number | null;
  is_open: boolean;
  snapshots: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  brokers: Array<Record<string, unknown>>;
  programs: Array<Record<string, unknown>>;
  /** 시간외호가(키움 0E) — `snapshots` 와 **다른 배열**이다. 사다리가 없고
   *  총잔량 두 개(`total_ask_qty`/`total_bid_qty`)만 들었다. */
  after_hours: Array<Record<string, unknown>>;
  ask_peak_today: LiveTodayAskPeak | null;
  bid_peak_today?: LiveTodayBidPeak | null;
}

/** Return shape of useLiveSeries. Lifted to a named type so the single-call
 * site (LivePage) can thread the value through useLiveBundle + LiveSidebar
 * as a prop. Two separate useLiveSeries calls would open two WebSocket subscriptions
 * and two independent buffers — HMR re-mounts cleared one but not the other,
 * leaving the sidebar's LATEST mode showing the empty-buffer state. */
export interface LiveSeriesData {
  initial: LiveSeriesResponse | undefined;
  isLoading: boolean;
  error: unknown;
  // ob/trade are narrowed to the shapes their consumers read (SR-1). The SSE
  // entries genuinely carry these fields (the poller's typed builders write
  // them); ObSnapshot/TradeSnapshot keep an index signature so the buffer's
  // structurally-untyped rows assign without an `as unknown as` double cast.
  ob: ReadonlyArray<ObSnapshot>;
  trade: ReadonlyArray<TradeSnapshot>;
  broker: ReadonlyArray<Record<string, unknown>>;
  program: ReadonlyArray<Record<string, unknown>>;
  /** 시간외호가(0E). 15:30 에 `ob` 가 끊기는 KRX-only 종목의 총잔량을 시간외에도
   *  잇는 유일한 소스다 — 사다리는 여기 없다. */
  afterHours: ReadonlyArray<Record<string, unknown>>;
}

/** Trailing-throttle window for coalescing live WS pushes into one buffer
 * re-read (and thus one /live re-render). ~6–7Hz cap: fast enough that hoga
 * indicators (bucketMs 1–30min) and the sidebar LATEST orderbook feel live,
 * slow enough to bound re-render cost when intraday push rates spike to
 * dozens–hundreds/s. See the subscribe effect for the trade-off note. */
const LIVE_FLUSH_MS = 150;
const EMPTY_OB_SNAPSHOTS: ReadonlyArray<ObSnapshot> = Object.freeze([]);
const EMPTY_TRADE_SNAPSHOTS: ReadonlyArray<TradeSnapshot> = Object.freeze([]);
const EMPTY_BROKER_SNAPSHOTS: ReadonlyArray<Record<string, unknown>> = Object.freeze([]);
const EMPTY_PROGRAM_SNAPSHOTS: ReadonlyArray<Record<string, unknown>> = Object.freeze([]);
const EMPTY_AH_SNAPSHOTS: ReadonlyArray<Record<string, unknown>> = Object.freeze([]);

/**
 * useLiveSeries — initial REST fetch + WebSocket subscription for live snapshots.
 *
 * - Initial fetch: GET /api/live/series → hydrates the in-memory buffer with
 *   anything already in the backend's ring buffer (e.g. session-to-date).
 * - WebSocket: subscribes via ws.ts (ADR-0053) and appends each live snapshot
 *   from the ws.ts live channel ({ch:'live', code, data}) to the buffer.
 * - Buffer cap: `LiveSnapshotBuffer` caps each kind at MAX_BUFFER_PER_KIND
 *   (Eng C5) so the page can run all day without unbounded growth.
 *
 * Returns parallel arrays per kind plus the initial response metadata so
 * panes can compute session bounds for chart timeframes.
 *
 * `venue` is **required**: 네 kind 가 **전부** 이 소스 경계에서 걸러진다 — ob·trade 는
 * filterObByVenue/filterTradeByVenue, broker·program 은 filterByVenueTag(아래 197~209).
 * 소비처가 global·mixed KRX+NXT 버퍼를 실수로 읽어 사용자의 venue 선택을 조용히
 * 무시하는 것을 막는다(execution-window-datasource-policy).
 *
 * program 의 백엔드 KRX-only 발행 강제는 **ADR-0140 §2 에서 걷혔다**. `stream.on_tick`
 * 은 broker·program 모두 `payload["venue"]` 태그를 실어 세 venue 를 전부 publish 하므로
 * (표시 경로 무게이트), venue 판정은 전부 여기서 한다.
 *
 * ⚠ **`initial` 만 예외로 필터되지 않는다.** REST 응답의 네 배열은 혼재 버퍼 원본
 * 그대로 나온다 — `/api/live/series` 의 `venue` 쿼리는 최대벽(ask/bid_peak_today)에만
 * 걸린다(라우트가 그 이유를 주석으로 밝힌다: 프레임마다 태그가 실려 프론트가 거르므로
 * 필수화하면 구 프론트가 빈 화면이 된다). 그래서 hydrate 를 거쳐 위 필터를 타는
 * ob·trade·broker·program 과 달리, `initial.brokers` 등을 **직접** 읽으면 세 시장이
 * 섞인 값을 본다.
 *
 * 필터 판정은 태그 **정확 일치**다(liveVenueAcceptsFrame). 따라서 KRX 선택이면 15:30
 * 이후 KRX 태그 프레임이 없어 broker·program 소비처가 정규장 마지막 값에서 멎는다
 * — 실측 2026-08-07 005930 WS 링 거래원: KRX 0건 · NXT 52 · UN 52.
 *
 * 인자는 **사용자 선택**이고, 실제로 쓰는 값은 `effectiveLiveVenue` 로 이 종목에
 * 맞게 해석한 `effective` 다(NXT 미상장 종목의 UN → KRX). 호출부가 선택값을 그대로
 * 넘겨도 되도록 해석을 여기서 삼킨다 — 소비 표면이 다섯 곳(DataWindow 의 호가·체결·
 * 거래원·매물대·프로그램)이라 각자 해석하게 두면 한 곳이 빠진다.
 */
export function useLiveSeries(code: string, venue: LiveVenueOption): LiveSeriesData {
  const date = unixMsToKSTDate(Date.now());
  // ⚠ 이 값이 **세 곳에 같이** 들어가야 한다: queryKey · REST URL · 아래 프레임 필터.
  // 하나라도 선택값이 남으면 캐시 키와 표시 내용이 갈린다.
  const effective = useEffectiveVenue(code, venue);
  const initial = useQuery({
    // ⚠ venue 가 **쿼리 키에도** 있어야 한다 — 없으면 venue 를 바꿔도 캐시가 안
    // 갈려 이전 venue 의 최대벽이 그대로 보인다(livePastCandles 와 같은 규율).
    queryKey: ['live', 'series', code, date, effective],
    queryFn: () =>
      apiCall<LiveSeriesResponse>(
        `/api/live/series?code=${encodeURIComponent(code)}&date=${date}&venue=${effective}`,
      ),
    enabled: !!code,
    staleTime: 60_000,
  });

  const bufferRef = useRef(new LiveSnapshotBuffer());
  const bufferOwnerRef = useRef<string | null>(null);
  const [tick, setTick] = useState(0); // bump to re-read buffer

  // Hydrate buffer when initial fetch completes.
  useEffect(() => {
    if (!initial.data) return;
    if (initial.data.code !== code) return;
    bufferOwnerRef.current = code;
    bufferRef.current.hydrate({
      ob: initial.data.snapshots as Array<{ t_ms: number; kind: string }>,
      trade: initial.data.trades as Array<{ t_ms: number; kind: string }>,
      broker: initial.data.brokers as Array<{ t_ms: number; kind: string }>,
      program: (initial.data.programs ?? []) as Array<{ t_ms: number; kind: string }>,
      ah: (initial.data.after_hours ?? []) as Array<{ t_ms: number; kind: string }>,
    });
    setTick((t) => t + 1);
  }, [initial.data, code]);

  // Subscribe to live snapshots over the shared WebSocket (ADR-0053). Pushes are
  // coalesced to one re-read per LIVE_FLUSH_MS window (trailing throttle): every
  // bump re-renders the whole /live consumer tree (LivePage → chart hoga panes +
  // sidebar orderbook + watchlist), so an unthrottled push rate (dozens–hundreds/s
  // intraday) would re-render the page that often. A bucketMs (1–30min) hoga
  // indicator and the sidebar LATEST view don't need sub-150ms freshness, so we
  // batch. (2026-06-09 bundle-split Phase C — coalescing; the heavier store split
  // was deliberately skipped as high-risk/low-marginal after Phase A/B memoised
  // the candle path.) Buffer accumulates every push; only the re-READ is throttled,
  // so no snapshot is dropped — the next flush sees them all. Trade-off: ≤150ms
  // display latency on live hoga + sidebar. 현재가 라인·상태바도 이 버퍼의 마지막
  // 체결가(freshLiveTradePrice)를 1순위로 쓰므로 같은 ≤150ms 지연이 적용된다;
  // useQuotes(10s 폴)는 체결이 뜸하거나 WS 단절일 때의 폴백이다.
  useEffect(() => {
    if (!code) return;
    bufferOwnerRef.current = code;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { timer = null; setTick((t) => t + 1); };
    const unsub = subscribeLive(code, (entry: LiveSnapshotEntry) => {
      if (bufferOwnerRef.current !== code) {
        bufferRef.current.clear();
        bufferOwnerRef.current = code;
      }
      bufferRef.current.push(entry);
      if (timer === null) timer = setTimeout(flush, LIVE_FLUSH_MS);
    });
    return () => {
      unsub();
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (bufferOwnerRef.current === code) bufferOwnerRef.current = null;
      bufferRef.current.clear();
      setTick(0);
    };
  }, [code]);

  // `tick` is intentionally passed to readKind so that React re-reads the
  // buffer on every WS push — bump state forces a re-render, readKind then
  // sees the updated buffer contents.
  const currentInitial = initial.data?.code === code ? initial.data : undefined;
  const bufferVisible = !!code && bufferOwnerRef.current === code;
  // One structural cast at the buffer boundary: the buffer stores raw
  // {t_ms, kind, ...payload} dicts; the 'ob'/'trade' kinds carry the
  // ObSnapshot/TradeSnapshot fields the poller's typed builders wrote.
  const rawOb = bufferVisible
    ? (readKind(bufferRef.current, 'ob', tick) as ReadonlyArray<ObSnapshot>)
    : EMPTY_OB_SNAPSHOTS;
  const rawTrade = bufferVisible
    ? (readKind(bufferRef.current, 'trade', tick) as ReadonlyArray<TradeSnapshot>)
    : EMPTY_TRADE_SNAPSHOTS;
  // venue 필터를 소스에서 강제한다. readKind 는 내용 불변 시 stable-ref 를 주므로
  // (LiveSnapshotBuffer.get) useMemo 가 재계산을 건너뛰어 소비처 memo 도 유지된다.
  const ob = useMemo(() => filterObByVenue(rawOb, effective), [rawOb, effective]);
  const trade = useMemo(() => filterTradeByVenue(rawTrade, effective), [rawTrade, effective]);
  // ⚠ broker·program 도 **같은 필터를 타야 한다.** 여기가 빠져 있어서 거래원·프로그램이
  // 호버(스팟) 중엔 venue 별로 나오는데 벗어나면(LATEST) 마지막 도착 프레임의 venue
  // 하나로만 나왔다 — 스팟은 파케이를 venue 별로 읽고, LATEST 는 이 버퍼를 쓴다.
  const rawBroker = bufferVisible
    ? readKind(bufferRef.current, 'broker', tick)
    : EMPTY_BROKER_SNAPSHOTS;
  const rawProgram = bufferVisible
    ? readKind(bufferRef.current, 'program', tick)
    : EMPTY_PROGRAM_SNAPSHOTS;
  const rawAfterHours = bufferVisible
    ? readKind(bufferRef.current, 'ah', tick)
    : EMPTY_AH_SNAPSHOTS;
  const broker = useMemo(() => filterByVenueTag(rawBroker, effective), [rawBroker, effective]);
  const program = useMemo(() => filterByVenueTag(rawProgram, effective), [rawProgram, effective]);
  // broker·program 과 같은 venue 필터를 탄다 — 위 ⚠ 주석의 결함을 새 kind 가
  // 되풀이하지 않게. 0E 는 KRX 종목에서만 관측됐지만(`_NX`/`_AL` 수신은 미실측)
  // 필터를 빼면 그 미실측이 화면에서 조용히 섞이는 형태로 드러난다.
  const afterHours = useMemo(
    () => filterByVenueTag(rawAfterHours, effective),
    [rawAfterHours, effective],
  );
  return {
    initial: currentInitial,
    isLoading: initial.isLoading,
    error: initial.error,
    ob,
    trade,
    broker,
    program,
    afterHours,
  };
}

// `tick` is ignored at runtime but referenced so React tracks the dep.
// Returns a readonly, stable-reference snapshot (see LiveSnapshotBuffer.get).
function readKind(
  buf: LiveSnapshotBuffer,
  kind: SnapshotKind,
  _tick: number,
): ReadonlyArray<Record<string, unknown>> {
  return buf.get(kind);
}

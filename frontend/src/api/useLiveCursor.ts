/**
 * Live-page cursor-keyed spot hooks (ADR-0044).
 *
 * Mirrors replay's useCursor.ts pattern using useSpot (not React Query).
 * All three hooks are parquet-only — SSE / stream modules are excluded per
 * ADR-0044. See useLiveCursor.invariant.test.ts for the static guard.
 *
 * Client-side bucket alignment: Math.floor(sidebarCursorMs / bucketMs) * bucketMs
 * is applied to both the URL `t=` param and the cache key to collapse
 * within-bucket motion to a single request.
 */
import { useEffect, useState } from 'react';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import type { SourcePreference } from '../state/sourcePreference';
import { useSpot } from './useSpot';
import { apiGet } from './client';
import { TIMEFRAME_TO_MS, type OrderbookResponse, type Timeframe } from './types';
import type { OrderbookSnapshot, BrokerSeriesEntry, SourceName } from './types';
import type { MinuteTimeframe } from '../state/livePage';
import { unixMsToKSTDate } from '../util/time';

// ─── Shared param type ────────────────────────────────────────────────────────

interface Params {
  code: string | null;
  timeframe: MinuteTimeframe | null;
}

// ─── Task 10 + T14b: useLiveOrderbookAtCursor ────────────────────────────────

/**
 * Full response shape returned by useLiveOrderbookAtCursor.
 * Includes available_from for the "다음 가용: HH:MM" hint (T14b, ADR-0044)
 * and source for the status chip.
 */
export interface LiveOrderbookSpot {
  snapshot: OrderbookSnapshot | null;
  available_from: number | null;
  source: SourceName;
}

/**
 * Live-side cursor-keyed orderbook spot, mirroring replay's
 * useOrderbookAtCursor. See ADR-0044 — parquet-only path, source_pref
 * threaded, client-side bucket alignment for cache stability.
 *
 * date is derived from sidebarCursorMs via unixMsToKSTDate, NOT passed as a prop —
 * this mirrors replay's useCursor pattern and fixes the regression where
 * hovering on past-date candles sent date=today to the API (ADR-0044).
 *
 * Returns undefined while loading / cursor absent, the full LiveOrderbookSpot
 * once fetched (snapshot may be null for pre-available slots).
 */
export function useLiveOrderbookAtCursor(p: Params): LiveOrderbookSpot | undefined {
  const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
  const sourcePref: SourcePreference = useSourcePreferenceStore((s) => s.sourcePreference);
  const bucketMs = p.timeframe ? TIMEFRAME_TO_MS[p.timeframe as Timeframe] : null;
  const alignedT =
    cursorMs !== null && bucketMs !== null
      ? Math.floor(cursorMs / bucketMs) * bucketMs
      : null;
  const date = cursorMs !== null ? unixMsToKSTDate(cursorMs) : null;

  const key =
    p.code && date && alignedT !== null && bucketMs !== null
      ? `live|ob|${p.code}|${date}|${alignedT}|${bucketMs}|${sourcePref}`
      : null;
  const { data } = useSpot<LiveOrderbookSpot>(key, () =>
    apiGet<OrderbookResponse>(
      `/api/orderbook?code=${p.code}&date=${date}&t=${alignedT}&bucket_ms=${bucketMs}&source_pref=${sourcePref}`,
    ).then((r) => ({
      snapshot: r.snapshot,
      available_from: r.available_from,
      source: r.source,
    })),
  );
  return data;
}

// ─── Task 12: useLiveBrokersAtCursor ─────────────────────────────────────────

interface BrokersParams {
  code: string | null;
  /** Minute timeframe, or null on D/W/M. Gates the fetch: /api/brokers/series
   *  is parquet-backed only on minute frames (ADR-0044). LiveChartRoot
   *  publishes sidebarCursorMs for sidebar/spot consumers, so without this
   *  gate a D/W/M hover would fire a spurious per-day series fetch. Mirrors
   *  useLiveOrderbookAtCursor's bucketMs gate. (The Pane Legend does NOT read
   *  the cursor store — it has its own crosshair subscription, so the store's
   *  only would-be D/W/M consumer is this hook.) */
  timeframe: MinuteTimeframe | null;
}

/**
 * Live-side cursor-keyed broker day-series spot. Fetches the whole day series
 * once per (code, date, sourcePref); sidebar projects per-row net at sidebarCursorMs
 * client-side via BrokerTrajectoryTable's binary-search (same as replay).
 *
 * Key intentionally does NOT include sidebarCursorMs — the day series is cursor-
 * independent; moving the cursor within the same day must not refetch.
 * Key gates on sidebarCursorMs presence (null key = no fetch in latest mode).
 *
 * date is derived from sidebarCursorMs via unixMsToKSTDate, NOT passed as a prop —
 * fixes the regression where hovering past-date candles queried date=today.
 *
 * ADR-0039: source_pref threaded. ADR-0044: parquet path only.
 */
export function useLiveBrokersAtCursor(
  p: BrokersParams,
): BrokerSeriesEntry[] | undefined {
  const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
  const sourcePref: SourcePreference = useSourcePreferenceStore((s) => s.sourcePreference);
  const date = cursorMs !== null ? unixMsToKSTDate(cursorMs) : null;
  // Key gates on cursor presence AND a minute timeframe — no fetch in latest
  // mode, and never on D/W/M (no per-cursor parquet; LiveChartRoot publishes
  // sidebar cursor on all frames). The key omits sidebarCursorMs — the day series is the
  // same for any t within (code, date).
  const key =
    p.code && date && p.timeframe !== null
      ? `live|br|${p.code}|${date}|${sourcePref}`
      : null;
  const { data } = useSpot<BrokerSeriesEntry[]>(key, () =>
    apiGet<{ date: string; brokers: BrokerSeriesEntry[]; source: SourceName }>(
      `/api/brokers/series?code=${p.code}&date=${date}&source_pref=${sourcePref}`,
    ).then((r) => r.brokers),
  );
  return data;
}

// ─── latest 모드 당일 궤적 (ADR-0044 amendment 2026-07-21) ────────────────────

/** 리페치 주기. 백엔드 Today Promotion 이 300초마다 brokers.parquet 을 다시 쓰므로
 *  그보다 잦을 필요는 없지만, 실패/건너뛴 사이클을 스스로 복구하고 15분 WS 버퍼
 *  이음매에 여유를 남기려 60초로 둔다 — 승격 지연(≤5분10초) + 60초 ≪ 15분. */
const TODAY_SERIES_REFRESH_MS = 60_000;

/**
 * 커서 없는 latest 모드에서 쓰는 **당일 전체** 거래원 궤적.
 *
 * useLiveBrokersAtCursor 와 같은 파케이 엔드포인트를 읽지만 두 가지가 다르다:
 * 커서가 아니라 "오늘" 로 키를 잡고, 장중에 계속 자라는 파일이라 주기적으로
 * 다시 읽는다(useSpot 은 키 단위 영구 캐시라 키에 시각 스탬프를 넣어야 갱신된다 —
 * 스팟 키를 재활용하면 화면이 첫 로드 시점에 얼어붙는다).
 *
 * ADR-0044 불변식 유지: 이 훅은 **parquet-only** 다. 승격 지연(≤약 5분 10초)으로
 * 비는 꼬리는 호출부가 WS 버퍼로 잇는다(liveSidebarAdapters의
 * mergeBrokerSeriesWithLiveTail) — orderbookSnapshotAtCursor 와 동일한 구조로,
 * 하이브리드는 fetcher 가 아니라 합성 레이어에 산다.
 *
 * code=null 이면 fetch 하지 않는다 — 스팟 모드일 때 호출부가 이걸로 잠재운다.
 */
export function useLiveBrokersToday(code: string | null): BrokerSeriesEntry[] | undefined {
  const sourcePref: SourcePreference = useSourcePreferenceStore((s) => s.sourcePreference);
  // 렌더 중 Date.now() 는 impure — 최초 1회 lazy init 후 인터벌로만 진행시킨다.
  // 스탬프가 날짜 파생의 근거이므로 자정 롤오버도 같이 따라간다.
  const [stampMs, setStampMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setStampMs(Date.now()), TODAY_SERIES_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const date = unixMsToKSTDate(stampMs);
  const key = code ? `live|br-today|${code}|${date}|${sourcePref}|${stampMs}` : null;
  const { data } = useSpot<BrokerSeriesEntry[]>(key, () =>
    apiGet<{ date: string; brokers: BrokerSeriesEntry[]; source: SourceName }>(
      `/api/brokers/series?code=${code}&date=${date}&source_pref=${sourcePref}`,
    ).then((r) => r.brokers),
  );
  return data;
}

/**
 * Live-page cursor-keyed spot hooks (ADR-0044).
 *
 * 호가 스냅샷은 replay 의 useCursor.ts 를 따라 `useSpot` 을 쓴다 — 키에 커서 시각이
 * 들어가는 rapid-scrub 전용 디바운서다. 거래원 두 훅은 **react-query 로 옮겼다**:
 * 키가 커서와 무관한 하루 단위라 두 소비 표면이 같은 키를 공유할 수 있고, 공유해야
 * 중복 발사와 재방문 미스가 사라진다. 근거·실측은 `brokerSeries.ts`.
 *
 * All three hooks are parquet-only — SSE / stream modules are excluded per
 * ADR-0044. See useLiveCursor.invariant.test.ts for the static guard — 그 가드는
 * 이 파일과 `brokerSeries.ts` **둘 다** 본다(거래원 fetcher 가 그리로 이사했으므로).
 *
 * Client-side bucket alignment: Math.floor(sidebarCursorMs / bucketMs) * bucketMs
 * is applied to both the URL `t=` param and the cache key to collapse
 * within-bucket motion to a single request.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { useEffectiveVenue } from '../live/useEffectiveVenue';
import { useOrderflowSourcePref } from '../state/sourcePreference';
import { useSpot } from './useSpot';
import { useBrokerSeriesForDay } from './brokerSeries';
import { apiGet } from './client';
import { TIMEFRAME_TO_MS, type OrderbookResponse, type Timeframe } from './types';
import type { OrderbookSnapshot, BrokerSeriesEntry, SourceName } from './types';
import type { MinuteTimeframe } from '../state/livePage';
import type { LiveVenueOption } from '../state/liveVenue';
import { unixMsToKSTDate } from '../util/time';
import {
  scaleOrderbookSnapshot,
  type AdjustFactors,
} from '../live/scaleRangeBundlePrices';

// ─── 커서 파생 날짜 디바운스 ──────────────────────────────────────────────────

/** 커서에서 파생한 **날짜**가 안정될 때까지 기다리는 시간.
 *
 * `useSpot` 시절 거래원 두 훅이 쓰던 디바운스와 같은 값이고 같은 일을 한다 —
 * react-query 에는 디바운스가 없으므로 keying **전에** 여기서 걸어야 한다. 안 걸면
 * `/study` 5개월 저장뷰를 가로로 훑을 때 스쳐간 날짜마다 요청이 하나씩 나가고
 * (수십~백 건), 그 응답이 전부 캐시에 앉는다.
 *
 * `BROKER_SERIES_GC_TIME_MS`(brokerSeries.ts)와 **짝이다** — 이쪽은 발생을,
 * 저쪽은 상주 시간을 막는다. 옛 판의 `capacity = 6` 이 혼자 하던 일이라 한쪽만
 * 두면 그 힙 사고(2026-07-29)가 절반만 막힌다.
 *
 * 늦추는 것은 날짜뿐이다. 종목·venue 는 즉시 반영된다 — 사용자가 방금 고른 값이라
 * 늦추면 그대로 체감 지연이 되고, 스크럽처럼 연속으로 바뀌지도 않는다. */
const CURSOR_DATE_DEBOUNCE_MS = 30;

/** 값이 `debounceMs` 동안 안정될 때까지 직전 값을 유지한다.
 *
 * 최초 값은 늦추지 않는다 — 마운트 시점의 값은 "스크럽 중에 스쳐간 값" 이 아니다. */
function useDebouncedValue<T>(value: T, debounceMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = setTimeout(() => setSettled(value), debounceMs);
    return () => clearTimeout(timer);
  }, [value, settled, debounceMs]);
  return settled;
}

// ─── Shared param type ────────────────────────────────────────────────────────

/** **사용자 선택** venue — 백엔드가 **필수**로 요구한다(ADR-0140: 기본값은 곧
 *  "빠뜨리면 조용히 KRX"). 훅 쪽도 같은 이유로 기본값을 두지 않고 호출부가
 *  명시한다 — `/live` 는 venue 선택기(useLiveVenueStore), `/study` 는 'KRX' 고정.
 *
 *  ⚠ 이 값은 **그대로 쓰이지 않는다.** 아래 훅들이 `useEffectiveVenue` 로 코드별
 *  유효 venue 를 해석한 뒤 URL·캐시 키에 넣는다. `useLiveSeries` 가 같은 이유로
 *  같은 일을 하고, 그 docstring 이 규칙을 명문화했다 — "호출부가 선택값을 그대로
 *  넘겨도 되도록 해석을 여기서 삼킨다. 소비 표면이 여러 곳이라 각자 해석하게
 *  두면 한 곳이 빠진다."
 *
 *  그 "빠진 한 곳"이 실제로 이 파일이었다(#1209 후속). NXT 미상장 종목에 통합(UN)
 *  을 고르면 백엔드는 `kiwoom_live/UN/` 을 **만든 적이 없다** — 구독 파생
 *  (`live/coverage.subscription_venues`)이 미상장 종목에 `("KRX",)` 만 주기
 *  때문이다. `_resolved_parquet_dir` 은 그 부재를 500 이 아니라 **빈 200** 으로
 *  정직하게 답하므로(#1133), 해석 없이 UN 을 그대로 보내면 창이 조용히 빈다.
 *  실측 2026-08-07 (003490 대한항공, `nxt_enabled=false`, dev :8000):
 *  `/api/brokers/series` 가 `venue=KRX` → 16 브로커 / 14,583 점, `venue=UN` → **0**.
 *  `/api/orderbook` 도 같은 종목에서 KRX 는 스냅샷, UN 은 `null` 이었다.
 *
 *  강등은 UN 에만 걸린다 — `venue=NXT` 의 빈 결과는 버그가 아니라 명시적 선택에
 *  대한 정직한 표시다(#1132, `effectiveLiveVenue` 주석).
 *
 *  캐시 키에도 **해석한 값**이 들어가야 한다. 선택값으로 키를 잡으면 UN 과 KRX 가
 *  같은 응답을 서로 다른 키에 두 벌 담아, 토글할 때마다 같은 데이터를 다시 받는다. */
type VenueParam = { venue: LiveVenueOption };

interface Params extends VenueParam {
  code: string | null;
  timeframe: MinuteTimeframe | null;
  /** 차트 봉에 곱해진 날짜별 수정계수(`groupChartLink.adjustFactors`).
   *
   *  이 스냅샷은 디스크 캡처라 **원주가**인데 같은 순간의 히트맵은 환산가로 그려진다 —
   *  안 넘기면 같은 호가 레벨이 패널과 차트에서 다른 숫자로 뜬다.
   *  근거·규약은 `scaleRangeBundlePrices`. */
  adjustFactors?: AdjustFactors;
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
 * 훅 반환 — **스냅샷과 그 신선도를 함께** 내보낸다.
 *
 * 값만 돌려주던 이전 판이 `/study` 의 "등락률만 바뀌고 10호가는 그대로" 버그를
 * 구조적으로 가능하게 했다: `useSpot` 은 키가 바뀌는 동안 이전 값을 유지하는데
 * (스크럽 UX 상 옳다) 소비처는 그 사실을 **알 방법이 없어서** 옛 사다리에 새
 * 커서에서 파생한 분모를 얹었다. 신선도를 값과 같은 자리에서 내보내는 것이
 * 그 구멍을 닫는다 — 소비처가 `stale` 을 무시하면 타입이 아니라 화면이 알려
 * 준다(딤이 안 걸린다).
 */
export interface LiveOrderbookSpotResult {
  /** 마지막으로 **성공한** 조회 결과. undefined = 아직 한 번도 못 받았거나 실패. */
  spot: LiveOrderbookSpot | undefined;
  /** `spot` 이 현재 커서의 것이 아닐 수 있다 — 새 키의 조회가 비행 중. */
  stale: boolean;
  /** 조회 실패. 이때 `spot` 은 undefined 다(틀린 옛 값을 남기지 않는다). */
  error: Error | null;
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
 * `spot` is undefined while loading / cursor absent, the full LiveOrderbookSpot
 * once fetched (snapshot may be null for pre-available slots). `stale` says the
 * carried value belongs to an older key; `error` says the fetch failed and the
 * value was dropped rather than left to rot. See LiveOrderbookSpotResult.
 */
export function useLiveOrderbookAtCursor(p: Params): LiveOrderbookSpotResult {
  const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
  // 선택값이 아니라 이 종목의 **유효** venue 로 조회한다 — 근거는 VenueParam.
  // code=null 이면 해석이 항등이라 무조건 불러도 안전하다(훅 순서 고정).
  const venue = useEffectiveVenue(p.code, p.venue);
  const sourcePref = useOrderflowSourcePref();
  const bucketMs = p.timeframe ? TIMEFRAME_TO_MS[p.timeframe as Timeframe] : null;
  const alignedT =
    cursorMs !== null && bucketMs !== null
      ? Math.floor(cursorMs / bucketMs) * bucketMs
      : null;
  const date = cursorMs !== null ? unixMsToKSTDate(cursorMs) : null;

  const key =
    p.code && date && alignedT !== null && bucketMs !== null && sourcePref
      ? `live|ob|${p.code}|${date}|${alignedT}|${bucketMs}|${sourcePref}|${venue}`
      : null;
  const { data, isFetching, error } = useSpot<LiveOrderbookSpot>(key, (signal) =>
    apiGet<OrderbookResponse>(
      `/api/orderbook?code=${p.code}&date=${date}&t=${alignedT}&bucket_ms=${bucketMs}&source_pref=${sourcePref}&venue=${venue}`,
      { signal },
    ).then((r) => ({
      snapshot: r.snapshot,
      available_from: r.available_from,
      source: r.source,
    })),
  );
  // 환산은 **fetch 결과의 파생**이다 — 캐시 키에 계수를 넣지 않는다. 키에 넣으면 계수가
  // 늦게 도착할 때 같은 스냅샷을 두 벌 받고, 안 넣으면서 환산을 fetch 안에서 하면 계수
  // 도착 전 캐시가 환산 없이 굳는다. 원본을 캐시하고 파생을 memo 하면 둘 다 없다.
  //
  // 환산 날짜는 **커서가 아니라 스냅샷 자신의 `ts_ms`** 다. 커서 날짜를 쓰면 비행
  // 중(옛 스냅샷 + 새 커서)에 다른 날의 수정계수가 옛 가격에 곱해져, 있지도 않았던
  // 가격의 사다리가 잠깐 뜬다. 스냅샷이 자기 날짜를 이미 싣고 있으므로 커서를
  // 참조할 이유가 없다.
  //
  // `stale` 은 **캐시에 넣지 않는다** — 신선도는 이 순간의 상태이지 응답의 속성이
  // 아니다. 캐시에 굳히면 재방문 히트가 지난번의 로딩 여부를 되살린다.
  const spot = useMemo(() => {
    if (data?.snapshot == null) return data;
    return {
      ...data,
      snapshot: scaleOrderbookSnapshot(
        data.snapshot,
        p.adjustFactors,
        unixMsToKSTDate(data.snapshot.ts_ms),
      ),
    };
  }, [data, p.adjustFactors]);
  return useMemo(
    () => ({ spot, stale: isFetching && spot !== undefined, error }),
    [spot, isFetching, error],
  );
}

// ─── Task 12: useLiveBrokersAtCursor ─────────────────────────────────────────

interface BrokersParams extends VenueParam {
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
 *
 * 조회 자체는 `useBrokerSeriesForDay` 가 한다 — latest 모드 훅과 **같은 캐시 키**를
 * 쓰기 위해서다. 이 훅이 하는 일은 "커서 → 날짜" 파생과 게이팅뿐이다.
 */
export function useLiveBrokersAtCursor(
  p: BrokersParams,
): BrokerSeriesEntry[] | undefined {
  const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
  const sourcePref = useOrderflowSourcePref();
  // 날짜가 곧 게이트다. 커서가 없으면(latest 모드) 잠들고, 달력 프레임(D·W·M)에서도
  // 잠든다 — LiveChartRoot 는 모든 프레임에서 sidebar 커서를 발행하지만 그쪽엔
  // 커서별 파케이가 없다(ADR-0044). 근거는 BrokersParams.timeframe.
  //
  // 날짜는 커서 **시각**이 아니라 날짜라, 같은 날 안에서 커서를 움직여도 바뀌지
  // 않는다 — 하루치 궤적은 그 날의 어느 t 에서나 같고, 행별 net 투영은 표가
  // 클라이언트에서 이분 탐색으로 한다.
  const rawDate =
    cursorMs !== null && p.timeframe !== null ? unixMsToKSTDate(cursorMs) : null;
  const date = useDebouncedValue(rawDate, CURSOR_DATE_DEBOUNCE_MS);
  return useBrokerSeriesForDay({
    code: p.code,
    date,
    sourcePref,
    // 선택값을 그대로 넘긴다 — 유효 venue 해석은 조회 훅이 삼킨다(VenueParam).
    venue: p.venue,
    // 커서가 오늘을 가리켜도 갱신하지 않는다 — `useSpot` 판의 동작(첫 fetch 에
    // 동결)과 같다. 자라는 꼬리가 필요한 화면은 latest 모드이고, 그쪽이 같은 키를
    // 60초로 갱신하므로 캐시를 공유하는 이 훅도 덩달아 신선해진다.
    liveRefreshMs: null,
  });
}

// ─── latest 모드 당일 궤적 (ADR-0044 amendment 2026-07-21) ────────────────────

/** 리페치 주기. 백엔드 Today Promotion 이 300초마다 brokers.parquet 을 다시 쓰므로
 *  그보다 잦을 필요는 없지만, 실패/건너뛴 사이클을 스스로 복구하고 15분 WS 버퍼
 *  이음매에 여유를 남기려 60초로 둔다 — 승격 지연(≤5분10초) + 60초 ≪ 15분. */
const TODAY_SERIES_REFRESH_MS = 60_000;

/**
 * 커서 없는 latest 모드에서 쓰는 **당일 전체** 거래원 궤적.
 *
 * useLiveBrokersAtCursor 와 **같은 엔드포인트·같은 캐시 키**를 읽는다. 다른 것은
 * 날짜를 커서가 아니라 "오늘" 로 잡는다는 것과, 장중에 계속 자라는 파일이라
 * 주기적으로 다시 읽는다는 것뿐이다.
 *
 * 갱신은 `refetchInterval` 이 맡는다. 옛 `useSpot` 판은 키 단위 영구 캐시라
 * 갱신하려면 **키에 60초 스탬프를 박는** 수밖에 없었고, 그 대가가 셋이었다:
 * 지나간 키는 다시 조회되지 않아 캐시가 "한 번 쓰고 버릴 사본" 의 무덤이 되고
 * (그래서 LRU 를 1 로 조여야 했고), 그 결과 **종목 재방문이 항상 미스**였으며,
 * 커서 훅과 키가 갈려 같은 URL 이 두 번 나갔다. 키가 안정된 지금은 셋 다 없다.
 *
 * ADR-0044 불변식 유지: 이 훅은 **parquet-only** 다. 승격 지연(≤약 5분 10초)으로
 * 비는 꼬리는 호출부가 WS 버퍼로 잇는다(liveSidebarAdapters의
 * mergeBrokerSeriesWithLiveTail) — orderbookSnapshotAtCursor 와 동일한 구조로,
 * 하이브리드는 fetcher 가 아니라 합성 레이어에 산다.
 *
 * code=null 이면 fetch 하지 않는다 — 스팟 모드일 때 호출부가 이걸로 잠재운다.
 */
export function useLiveBrokersToday(
  code: string | null,
  selectedVenue: LiveVenueOption,
): BrokerSeriesEntry[] | undefined {
  const sourcePref = useOrderflowSourcePref();
  // 렌더 중 Date.now() 는 impure — 최초 1회 lazy init 후 인터벌로만 진행시킨다.
  // 이 스탬프는 이제 **날짜 파생에만** 쓴다(자정 롤오버를 따라가려고). 갱신 자체는
  // refetchInterval 이 하므로 스탬프는 캐시 키에 들어가지 않는다 — 들어가면 위
  // docstring 의 대가 셋이 그대로 돌아온다.
  const [stampMs, setStampMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setStampMs(Date.now()), TODAY_SERIES_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  return useBrokerSeriesForDay({
    code,
    date: unixMsToKSTDate(stampMs),
    sourcePref,
    // 선택값을 그대로 넘긴다 — 유효 venue 해석은 조회 훅이 삼킨다(VenueParam).
    venue: selectedVenue,
    liveRefreshMs: TODAY_SERIES_REFRESH_MS,
  });
}

/**
 * 얼린 저장뷰 분봉의 **미캡처 거래일을 키움으로 보충**한다.
 *
 * 계획(어느 구간을 물어볼지)은 `minuteGapFillPlan` 이 소유하고, 이 훅은 그 계획을
 * **한 번에 하나씩 순차로** 소비한다. 두 가지가 그 순차성에 달려 있다:
 *
 * 1. **훅 규칙** — run 개수는 데이터에 따라 변하므로 run 마다 `useQuery` 를 부를 수 없다.
 *    커서 하나로 훑으면 훅 호출 수가 고정된다.
 * 2. **벤더 예산** — walk 를 여러 개 동시에 부채질하면 이웃 walk 끼리 같은 날짜를 중복
 *    수신한다(키움 1콜이 900행 ≈ 2.35거래일을 덮으므로). 순차가 콜 수를 최소화한다.
 *
 * ## 척도 절벽을 여기서 막는다
 *
 * 키움 past-candles 는 **오늘 기준 수정계수를 곱해서** 응답한다
 * (`live_candle_backfill._apply_walk_result` — "저장값이 곧 표시값"). 디스크 캡처는
 * **캡처 당시 원주가**다. 구간과 오늘 사이에 분할·증자가 있으면 두 소스가 서로 다른
 * 척도로 이어붙어 차트에 절벽이 생긴다.
 *
 * 그래서 응답이 **실제로 곱한 계수**(`adjust_factors`)를 읽어 **1이 아닌 날짜는 버린다.**
 * 버린 사실은 `rescaledDates` 로 올려 안내가 말하게 한다 — 조용히 섞는 것보다 조용히
 * 비우는 편이 낫고, 비운 이유를 말하면 둘 다 아니다.
 *
 * 역스케일(÷factor)로 디스크 척도에 맞추는 길도 있지만 벤더 캐시 슬롯에 척도 축을
 * 추가해야 해서(지금은 `(tic_scope, date)` 뿐) 비용이 다르다 — 별도 작업이다.
 *
 * ## 이 훅이 채운 날짜는 **캔들만** 있다
 *
 * 호가 파생(호가비·체결강도·매물대·최대벽·depth)은 그 순간 받아 두지 않으면 영원히
 * 없는 데이터라 소급할 수 없다(`hogaMissingNotice` 가 그 사실을 설명한다). 보충일의
 * 소스를 `kiwoom_gapfill` 로 표시하는 이유가 그것이다 — 배지가 "이 날은 다른 소스" 라고
 * 말해야 사용자가 지표 pane 이 빈 것을 고장으로 읽지 않는다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiCall } from '../api/client';
import {
  PAST_CANDLES_TIMEOUT_MS,
  withPastCandlesTimeout,
  type LivePastCandle,
  type LivePastCandlesResponse,
} from '../api/livePastCandles';
import type { LiveVenueOption } from '../state/liveVenue';
import {
  isMinuteTimeframe,
  needsRegularSessionClip,
  fetchBucketMsFor,
  type LiveTimeframe,
} from '../state/livePage';
import {
  TIMEFRAME_TO_MS,
  type Candle,
  type RangeMissingDate,
  type Timeframe,
} from '../api/types';
import { aggregateCandles, keepRegularSessionCandles } from './aggregateCandles';
import { realMsToYyyymmdd } from './liveDateTime';
import { gapFillRunKey, planMinuteGapFill, type GapFillRun } from './minuteGapFillPlan';

const EMPTY_CANDLES: readonly Candle[] = [];
const EMPTY_DATES: readonly string[] = [];
const EMPTY_DATE_SET: ReadonlySet<string> = new Set<string>();

/** 계수 동일성 판정 여유. 계수는 `일봉 종가 비율`이라 부동소수 잔차가 남는다. */
const FACTOR_EPSILON = 1e-9;

export interface MinuteGapFillResult {
  /** 보충된 봉 — 표시 타임프레임으로 접힌 상태, 시간 오름차순. */
  candles: readonly Candle[];
  /** 실제로 채워진 거래일. 소스 표기(`kiwoom_gapfill`)가 이 집합을 쓴다. */
  filledDates: ReadonlySet<string>;
  /** 척도가 달라(계수 ≠ 1) 보충을 포기한 거래일. */
  rescaledDates: readonly string[];
  /** 키움 보유(1년) 밖이라 애초에 요청하지 않은 거래일 수. */
  unfillableCount: number;
  /** 총량 상한에 걸려 이번에 시도하지 않은 거래일 수. */
  deferredCount: number;
  /** 아직 시도하지 않은 run 수. 0 이면 이 창의 보충이 끝났다. */
  remainingRuns: number;
  /** 지금 벤더 응답을 기다리는 중인가. */
  isFetching: boolean;
}

const IDLE: MinuteGapFillResult = {
  candles: EMPTY_CANDLES,
  filledDates: EMPTY_DATE_SET,
  rescaledDates: EMPTY_DATES,
  unfillableCount: 0,
  deferredCount: 0,
  remainingRuns: 0,
  isFetching: false,
};

interface Accumulator {
  /** 거래일 → 그 날의 벤더 봉(요청 해상도 그대로). */
  byDate: Map<string, LivePastCandle[]>;
  rescaled: Set<string>;
}

function emptyAccumulator(): Accumulator {
  return { byDate: new Map(), rescaled: new Set() };
}

function toCandle(b: LivePastCandle): Candle {
  return {
    ts_ms: b.t_ms,
    open: b.open,
    close: b.close,
    high: b.high,
    low: b.low,
    vol_a: b.volume,
    vol_b: 0,
  };
}

/**
 * 한 run 의 응답을 누적기에 흩뿌린다. **요청한 날짜만** 취한다.
 *
 * 벤더 walk 는 커서 프로토콜상 요청 구간 밖의 날짜도 함께 실어 오는데(수확분), 그것을
 * 그대로 받으면 **디스크에 이미 있는 날짜를 키움 봉으로 덮는다** — 이 기능은 union 이지
 * 우선순위 병합이 아니므로 그 순간 계약이 깨진다.
 */
function absorbRun(acc: Accumulator, run: GapFillRun, res: LivePastCandlesResponse): void {
  const wanted = new Set(run.dates);
  const factors = res.adjust_factors ?? {};
  const barsByDate = new Map<string, LivePastCandle[]>();
  for (const bar of res.candles) {
    const date = realMsToYyyymmdd(bar.t_ms);
    if (!wanted.has(date)) continue;
    const list = barsByDate.get(date);
    if (list) list.push(bar);
    else barsByDate.set(date, [bar]);
  }
  for (const [date, bars] of barsByDate) {
    const factor = factors[date];
    // 계수를 모르는 날짜는 백엔드가 봉도 싣지 않는다 — 그래도 방어적으로 버린다.
    // 무척도 봉을 그리면 화면에는 정상으로 보이는 절벽이 남는다.
    if (factor === undefined) continue;
    if (Math.abs(factor - 1) > FACTOR_EPSILON) {
      acc.rescaled.add(date);
      continue;
    }
    acc.byDate.set(date, bars);
  }
}

/**
 * 누적된 벤더 봉을 표시 타임프레임으로 접는다.
 *
 * 접는 방식은 `useLiveBundle` 의 벤더 경로와 같아야 한다 — 같은 차트에 나란히 놓이는
 * 봉이라 격자가 어긋나면 보충일만 폭이 다른 봉이 된다. 120·240 의 정규장 클립까지
 * 포함해 그 경로를 그대로 따른다.
 */
function foldToTimeframe(acc: Accumulator, timeframe: LiveTimeframe): readonly Candle[] {
  if (acc.byDate.size === 0) return EMPTY_CANDLES;
  const dates = [...acc.byDate.keys()].sort();
  const out: Candle[] = [];
  for (const date of dates) {
    const raw = acc.byDate.get(date) ?? [];
    if (raw.length === 0) continue;
    // 날짜별로 접는다 — 버킷 경계가 날짜를 넘지 않으므로 결과는 통짜 집계와 같고,
    // 날짜 사이가 비어 있어도(구멍은 원래 흩어져 있다) 빈 버킷이 생기지 않는다.
    const src = needsRegularSessionClip(timeframe) ? keepRegularSessionCandles(raw) : raw;
    if (src.length === 0) continue;
    for (const bar of aggregateCandles(src, TIMEFRAME_TO_MS[timeframe as Timeframe] / 1000)) {
      out.push(toCandle(bar));
    }
  }
  return out;
}

export interface UseMinuteGapFillArgs {
  /**
   * 보충을 켤 것인가. 호출자가 **세 가지를 모두** 만족시켜야 한다:
   * 얼린 저장뷰(`frozenRangeFrom !== null`) · 분봉 · KRX.
   *
   * 전역 `rest_bypass_enabled` 에서는 **켜지 않는다** — 그 모드는 벤더가 실패할 때
   * 사용자에게 주는 처방이라(`restBypassMode` 의 `notifyFailure` 경로), 그 상태에서
   * 자동으로 벤더를 두드리면 모드의 목적을 정면으로 무효화한다.
   */
  enabled: boolean;
  code: string | null;
  venue: LiveVenueOption;
  timeframe: LiveTimeframe;
  todayKstYyyymmdd: string;
  /** `/api/range` 응답의 `missing_dates` — 구멍 날짜의 유일 출처. */
  missingDates: readonly RangeMissingDate[] | undefined;
}

export function useMinuteGapFill(args: UseMinuteGapFillArgs): MinuteGapFillResult {
  const { enabled, code, venue, timeframe, todayKstYyyymmdd, missingDates } = args;
  const active = enabled && !!code && isMinuteTimeframe(timeframe) && venue === 'KRX';
  const bucketMs = isMinuteTimeframe(timeframe) ? fetchBucketMsFor(timeframe) : 60_000;

  const plan = useMemo(
    () => (active
      ? planMinuteGapFill({ missingDates, todayKstYyyymmdd, bucketMs })
      : { runs: [], unfillable: [], deferred: [] }),
    [active, missingDates, todayKstYyyymmdd, bucketMs],
  );

  // 계획이 바뀌면 누적을 버린다. 종목·venue·해상도가 바뀌어도 마찬가지 — 다른 척도·다른
  // 시장의 봉을 이어 붙이면 안 된다.
  const identity = `${code ?? ''}|${venue}|${bucketMs}|${plan.runs.map(gapFillRunKey).join(',')}`;

  const accRef = useRef<Accumulator>(emptyAccumulator());
  const processedRef = useRef<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [seenIdentity, setSeenIdentity] = useState(identity);
  if (seenIdentity !== identity) {
    // 렌더 중 리셋 — props 변화에 맞춰 state 를 조정하는 공식 패턴이다. effect 로 미루면
    // 한 프레임 동안 **옛 계획의 누적본**이 새 종목 차트에 그려진다.
    setSeenIdentity(identity);
    setCursor(0);
    accRef.current = emptyAccumulator();
    processedRef.current = new Set();
  }

  const run: GapFillRun | null = active && cursor < plan.runs.length ? plan.runs[cursor] : null;

  const query = useQuery({
    queryKey: ['live', 'gap-fill', code, venue, bucketMs, run?.from ?? null, run?.to ?? null] as const,
    queryFn: ({ signal }) => apiCall<LivePastCandlesResponse>(
      `/api/live/past-candles?code=${code}&from=${run?.from}&to=${run?.to}`
      + `&venue=${venue}&bucket_ms=${bucketMs}`,
      { signal: withPastCandlesTimeout(signal, PAST_CANDLES_TIMEOUT_MS) },
    ),
    enabled: run !== null,
    // 과거 확정 구간이라 만료가 없다. 팬·줌으로 이 훅이 다시 렌더돼도 재요청하지 않는다.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    // 실패해도 다음 run 으로 넘어간다 — 한 구간의 실패가 나머지를 막으면 안 되고,
    // 무자격 환경(503 NOT_WIRED)에서는 모든 run 이 실패하므로 재시도가 순수 낭비다.
    retry: false,
  });

  const { data, isSuccess, isError } = query;
  useEffect(() => {
    if (run === null) return;
    const key = gapFillRunKey(run);
    if (processedRef.current.has(key)) return;
    if (isSuccess && data) {
      absorbRun(accRef.current, run, data);
    } else if (!isError) {
      return;
    }
    processedRef.current.add(key);
    setCursor((c) => c + 1);
  }, [run, data, isSuccess, isError]);

  // `cursor` 가 누적기의 **버전**이다. 누적은 ref 라 deps 에 넣을 수 없고, run 이 하나
  // 끝날 때마다 커서가 정확히 한 번 오르므로 그 값이 곧 "몇 번 흡수했는가" 다.
  const candles = useMemo(
    () => foldToTimeframe(accRef.current, timeframe),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cursor 가 accRef 의 버전
    [cursor, identity, timeframe],
  );
  const filledDates = useMemo<ReadonlySet<string>>(
    () => new Set(accRef.current.byDate.keys()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 위와 같은 이유
    [cursor, identity],
  );
  const rescaledDates = useMemo<readonly string[]>(
    () => [...accRef.current.rescaled].sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 위와 같은 이유
    [cursor, identity],
  );

  // 결과를 memo 로 고정한다 — 매 렌더 새 객체를 내면 이 값을 deps 로 쓰는 하류
  // (저장뷰 안내·소스 맵)가 전부 재계산된다. 보충은 드물게 움직이는 데이터라 참조가
  // 안정적이어야 그 비용이 0 이 된다.
  const isFetching = query.isFetching;
  const remainingRuns = Math.max(0, plan.runs.length - cursor);
  return useMemo<MinuteGapFillResult>(
    () => (active
      ? {
          candles,
          filledDates,
          rescaledDates,
          unfillableCount: plan.unfillable.length,
          deferredCount: plan.deferred.length,
          remainingRuns,
          isFetching,
        }
      : IDLE),
    [
      active, candles, filledDates, rescaledDates,
      plan.unfillable.length, plan.deferred.length, remainingRuns, isFetching,
    ],
  );
}

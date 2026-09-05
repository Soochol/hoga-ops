import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import type { AskPeakCandidate } from './types';
import type { ObSnapshot, TradeSnapshot } from '../live/bucketHogaSeries';
import { useEffectiveVenue } from '../live/useEffectiveVenue';
import type { LiveVenueOption } from '../state/liveVenue';
import { useKstDay } from '../util/useKstDay';
import { hydrateLiveSeries, readLiveSeries, subscribeLiveSeries } from './sharedLiveSeries';
export { pickLastKnownOb } from './sharedLiveSeries';

export type LiveTodayPeakBase = {
  date: string;
  coverage: 'full' | 'partial';
  /** 동일분 터치 벽(ADR-0156) 랭킹 1위 — 와이어 이름은 이관 비용 때문에 유지한다. */
  traded_price: number | null;
  traded_qty: number | null;
  traded_t_ms: number | null;
  traded_peaks?: AskPeakCandidate[];
  /** 터치된 벽의 **기록 갱신 시퀀스**(시간순 prefix maxima) — 최대벽 강도 pane 계단의
   *  입력. `traded_peaks`(최종 크기순 top-3)와 **축이 다르다**: 벽은 장중에 커지는
   *  경향이라 top-3 이 오후에 몰리면 오전 기록이 전부 잘린다.
   *
   *  ⚠ **rep/cont 를 가르지 않는 단일 배열이다** — 라이브 상태엔 버킷 대표라는 개념이
   *  없어 두 축이 같은 값이다(백엔드 `snapshot()` 주석). 프론트는 이 하나를
   *  `traded_record_peaks`·`traded_record_max_peaks` 양쪽에 배선한다. 구백엔드 부재
   *  → optional. */
  traded_record_peaks?: AskPeakCandidate[];
  /** 분별 최대 체결 벽 — 최대벽 강도 pane 의 **봉별 모드** 입력(백엔드
   *  `traded_bar_max`). 위 기록 시퀀스와 **같은 축 규약**이라 여기서도 단일 배열이고,
   *  프론트가 `traded_bar_peaks`·`traded_bar_max_peaks` 양쪽에 배선한다.
   *  구백엔드 부재 → optional. */
  traded_bar_peaks?: AskPeakCandidate[];
  /** 전체 계열의 분별 최대(터치 무관) — 위와 같은 축 규약(단일 배열). */
  all_bar_peaks?: AskPeakCandidate[];
  all_price: number;
  all_qty: number;
  all_t_ms: number;
  /** 미도달 벽 — 당일 체결 극값(ask=고가/bid=저가)이 가격으로 지배하지 못한 벽의
   *  rank-1/top-3. 극값이 전진하면 벽이 이 계열에서 **빠진다**(소급 재분류) — 값이
   *  줄어드는 방향의 갱신은 클라이언트가 `day_extreme` ∪ 버퍼 체결 극값으로 재필터해
   *  따라간다. 구백엔드 부재 → optional. */
  unreached_price?: number | null;
  unreached_qty?: number | null;
  unreached_t_ms?: number | null;
  unreached_peaks?: AskPeakCandidate[];
  /** 서버가 그 시점까지 본 당일 체결 극값 — 미도달 재필터의 기준. null = 체결 0건. */
  day_extreme?: number | null;
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
  /** 예상체결(키움 0H) — `snapshots` 와 **다른 배열**이다. 사다리가 없고
   *  `expected_price`/`expected_qty` 두 개만 들었다. */
  expected: Array<Record<string, unknown>>;
  /** 이 venue 의 **마지막 호가 프레임** — `snapshots` 가 그 venue 를 다 잃었을 때의
   *  폴백이다(백엔드 `LiveBuffer._last_ob`). 배열이 아니라 **한 장**인 것이 요점:
   *  10호가 창은 LATEST 하나면 되고, 계열이 필요한 소비자(매물대·지표)는 그대로
   *  `snapshots` 를 쓴다.
   *
   *  shape 을 좁히지 않는 이유는 위 네 배열과 같다 — 항목 shape 은 스트림이 소유하고,
   *  여기서 미러를 한 벌 더 만들면 조용한 스트립 위험만 는다. */
  last_ob?: Record<string, unknown> | null;
  ask_peak_today: LiveTodayAskPeak | null;
  bid_peak_today?: LiveTodayBidPeak | null;
}

/** 창별 REST 메타데이터와 공유 실시간 스냅샷의 소비 계약. */
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
  expected: ReadonlyArray<Record<string, unknown>>;
}

/** REST 메타데이터는 venue별 Query 캐시, 틱 버퍼는 종목·거래일별 공유 저장소다.
 * 같은 종목의 차트·데이터 창들이 수신/축출/복사/필터를 한 번만 수행한다.
 * venue 해석은 REST 키·URL·공유 스냅샷 선택 세 곳에 동일하게 적용한다.
 */
export function useLiveSeries(code: string, venue: LiveVenueOption): LiveSeriesData {
  const date = useKstDay();
  const effective = useEffectiveVenue(code, venue);
  const initial = useQuery({
    queryKey: ['live', 'series', code, date, effective],
    queryFn: () => apiCall<LiveSeriesResponse>(
      `/api/live/series?code=${encodeURIComponent(code)}&date=${date}&venue=${effective}`,
    ),
    enabled: !!code,
    staleTime: 60_000,
  });
  const subscribe = useCallback((notify: () => void) => subscribeLiveSeries(code, date, notify), [code, date]);
  const getSnapshot = useCallback(() => readLiveSeries(code, date, effective), [code, date, effective]);
  const frames = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (initial.data) hydrateLiveSeries(code, date, effective, initial.data);
  }, [initial.data, code, date, effective]);
  return {
    initial: initial.data?.code === code ? initial.data : undefined,
    isLoading: initial.isLoading,
    error: initial.error,
    ...frames,
  };
}

/** GET /api/market/futures-quotes — 지수 카드의 선물 토글 데이터.
 *
 * 지수 현물(`marketIndexQuotes`)과 **벤더가 다르다**(KIS). 키움에 파생 TR 이 0건이라
 * 대체 경로가 없어서, ADR-0136 의 "실시간·폴링은 전부 키움" 분담에서 이 표면만 KIS 다.
 * 그래서 훅도 표면도 따로다 — 한 응답에 섞으면 어느 벤더가 늦었는지 사라진다.
 *
 * **`session` 과 quote 의 `dataSession` 은 다를 수 있고, 종목마다도 다르다.**
 * KIS REST 는 야간장 중에도 **주간 마감 스냅샷**을 주고(15:45 동결), 야간 실시간은
 * WS 로만 오는데 그 틱은 유동성 있는 종목에만 붙는다 — 실측(2026-08-07 00:36, 40초)
 * 에서 KOSPI200 48틱 / 코스닥150 0틱 / VKOSPI 0틱이었다. 그래서 같은 순간에 한
 * 카드는 야간 실시간이고 옆 카드는 주간 마감본일 수 있다. **카드마다** 배지를 단다.
 */
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export type FuturesSession = 'day' | 'night' | 'closed';

interface FuturesDayValuesWire {
  value: number;
  change: number;
  change_rate: number;
  prev_close: number;
  volume: number;
  open_interest: number;
  oi_change: number;
  market_basis: number | null;
  disparity: number | null;
  t_ms: number;
}

interface FuturesQuoteWire {
  id: string;
  underlying_id: string | null;
  label: string;
  code: string;
  expiry: string;
  days_left: number | null;
  last_trade_date: string | null;
  value: number;
  change: number;
  change_rate: number;
  prev_close: number;
  volume: number;
  open_interest: number;
  oi_change: number;
  market_basis: number | null;
  disparity: number | null;
  data_session: FuturesSession;
  t_ms: number;
  day: FuturesDayValuesWire | null;
}

interface FuturesQuotesResponseWire {
  quotes: FuturesQuoteWire[];
  session: FuturesSession;
  unavailable: string | null;
}

/** 야간 틱이 덮기 **전**의 주간 값 — 카드에서 주간↔야간을 고를 수 있게 하는 짝.
 *
 * 야간 REST 가 주간 마감본을 계속 준다는 성질(15:45 동결)이 여기서는 이점이 된다:
 * 두 세션의 값이 추가 호출 없이 동시에 손에 있다. 반대 방향은 성립하지 않는다 —
 * **낮에 전날 야간 값을 얻을 경로는 벤더에 없다**(2026-08-08 실측: 분봉 앵커를
 * 야간으로 줘도 주간 83봉, `MF` 분류코드는 `OPSQ2001` 명시 거부). 그쪽은 우리가
 * 저장한 기록으로만 가능하고 그건 별개 작업이다.
 */
export interface FuturesDayValues {
  value: number;
  change: number;
  changeRate: number;
  prevClose: number;
  volume: number;
  openInterest: number;
  oiChange: number;
  marketBasis: number | null;
  disparity: number | null;
  tMs: number;
}

export interface FuturesQuote {
  id: string;
  /** 대응 현물 지수 id. null 이면 토글 짝이 없는 **선물 전용 카드**(VKOSPI). */
  underlyingId: string | null;
  label: string;
  code: string;
  expiry: string;
  daysLeft: number | null;
  lastTradeDate: string | null;
  value: number;
  change: number;
  changeRate: number;
  prevClose: number;
  volume: number;
  openInterest: number;
  oiChange: number;
  /** 시장 베이시스(선물 − 기초자산). 이론 베이시스가 아니다 — 부호가 다르다. */
  marketBasis: number | null;
  disparity: number | null;
  /** 이 값이 속한 세션. 스냅샷의 `session` 과 다르면 낡은 값이다(종목마다 다르다). */
  dataSession: FuturesSession;
  tMs: number;
  /** 야간 값이 덮기 전의 주간 값. **`null` 이면 이 카드에는 선택지가 없다** —
   *  주간 카드는 최상위 필드가 이미 주간이라 여기 채우면 같은 숫자가 두 벌이 된다. */
  day: FuturesDayValues | null;
}

export interface FuturesQuotesSnapshot {
  quotes: FuturesQuote[];
  /** 지금 열려 있는 세션. 값별 세션은 각 quote 의 `dataSession` 을 볼 것. */
  session: FuturesSession;
  unavailable: string | null;
}

function mapQuote(wire: FuturesQuoteWire): FuturesQuote {
  return {
    id: wire.id,
    underlyingId: wire.underlying_id,
    label: wire.label,
    code: wire.code,
    expiry: wire.expiry,
    daysLeft: wire.days_left,
    lastTradeDate: wire.last_trade_date,
    value: wire.value,
    change: wire.change,
    changeRate: wire.change_rate,
    prevClose: wire.prev_close,
    volume: wire.volume,
    openInterest: wire.open_interest,
    oiChange: wire.oi_change,
    marketBasis: wire.market_basis,
    disparity: wire.disparity,
    dataSession: wire.data_session,
    tMs: wire.t_ms,
    day: wire.day == null ? null : {
      value: wire.day.value,
      change: wire.day.change,
      changeRate: wire.day.change_rate,
      prevClose: wire.day.prev_close,
      volume: wire.day.volume,
      openInterest: wire.day.open_interest,
      oiChange: wire.day.oi_change,
      marketBasis: wire.day.market_basis,
      disparity: wire.day.disparity,
      tMs: wire.day.t_ms,
    },
  };
}

export interface FuturesSparkCoverage {
  /** 관측을 시작한 시각 `HHMM`. `"1800"` 이면 야간 개장부터 온전히 봤다는 뜻. */
  firstHhmm: string;
  /** 관측한 5분 버킷 수. 실제 봉 수보다 크거나 같다(무음 구간 포함). */
  observedBuckets: number;
  /** 관측이 끊긴 횟수 — 서버 재시작·유휴 정지마다 1 늘어난다. */
  gapCount: number;
}

export interface FuturesSpark {
  /** 시간순(과거→최신) 5분봉 종가. */
  closes: number[];
  /** 시가 — 스파크라인 색 기준선. 야간 시리즈는 null(첫 점이 곧 야간 시가). */
  dayOpen: number | null;
  /**
   * 이 **그림**이 어느 세션 것인지. quote 의 `dataSession` 과 짝이다.
   *
   * 종목마다 다르다 — 야간 봉이 쌓인 카드는 `night`, 무음인 카드는 그날 주간장
   * 모양이라 `day` 다. 둘이 어긋난 채 그리면 사용자는 주간 하락을 야간에 일어난
   * 것으로 읽는다.
   */
  session: FuturesSession;
  /**
   * 야간 시리즈의 관측 구간. **주간은 null** — REST 는 날짜를 지정해 다시 받을 수
   * 있어서 "놓친 구간" 개념이 없다.
   *
   * 야간 봉은 프로세스 메모리에만 있고 소급 조회 경로가 없다. 스파크라인엔 축이
   * 없어서 18:00 부터 8시간을 그린 선과 02:00 부터 10분을 그린 선이 화면에서
   * 구별되지 않으므로, 앞이 잘렸다는 사실을 이 값으로 말한다.
   */
  coverage: FuturesSparkCoverage | null;
  /** 야간 시리즈일 때 같이 오는 **그날 주간장** 모양. 값 쪽 `day` 와 짝이다 —
   *  한쪽만 있으면 '주간' 선택이 숫자만 바꾸고 그림은 비운다. */
  day: { closes: number[]; dayOpen: number | null } | null;
}

interface FuturesCandlesResponseWire {
  series: Record<
    string,
    {
      closes: number[];
      day_open: number | null;
      session: FuturesSession;
      coverage: {
        first_hhmm: string;
        observed_buckets: number;
        gap_count: number;
      } | null;
      day: { closes: number[]; day_open: number | null } | null;
    }
  >;
}

/** 선물 스파크라인 — 카드 id → 종가 배열.
 *
 * 시세와 훅을 나눈 이유는 갱신 축이 다르기 때문이다: 시세는 20초마다 의미가 바뀌지만
 * 5분봉은 5분에 한 번만 늘어난다. 한 쿼리로 묶으면 분봉이 시세 주기로 끌려 올라간다.
 *
 * **`enabled` 는 필수 인자다.** 기본값 `true` 를 주면 게이트를 빠뜨린 호출처가 조용히
 * 옛 동작(항상 폴링)으로 돌아가고, 그건 증상이 없어서 아무도 못 찾는다.
 *
 * 시세 쪽(`useMarketFutures`)에는 같은 게이트를 **달면 안 된다** — 토글을 그릴지
 * 정하는 것이 그 응답이고(선물이 없는 카드엔 토글이 안 붙는다), 야간 WS 를 깨우는
 * 것도 그 폴링이다(백엔드 `_night_ticks` 가 시세 수집 안에서만 WS 를 연다). 끄면
 * 야간 봉이 영영 안 쌓인다.
 *
 * `refetchInterval` 대신 `enabled` 를 쓰는 이유: 함수형 `refetchInterval` 이 `false`
 * 를 돌려주면 타이머가 사라져 **스스로 되살아나지 못한다**(#1182). `enabled` 는 매
 * 렌더 재평가되므로 토글을 누른 그 렌더에 바로 켜진다. */
export function useMarketFuturesCandles(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ['market-futures-candles'],
    queryFn: async ({ signal }): Promise<Record<string, FuturesSpark>> => {
      const r = await apiCall<FuturesCandlesResponseWire>('/api/market/futures-candles', {
        signal,
      });
      return Object.fromEntries(
        Object.entries(r.series ?? {}).map(([id, s]) => [
          id,
          {
            closes: s.closes ?? [],
            dayOpen: s.day_open,
            session: s.session,
            coverage: s.coverage
              ? {
                  firstHhmm: s.coverage.first_hhmm,
                  observedBuckets: s.coverage.observed_buckets,
                  gapCount: s.coverage.gap_count,
                }
              : null,
            day: s.day == null ? null : { closes: s.day.closes ?? [], dayOpen: s.day.day_open },
          },
        ]),
      );
    },
    refetchInterval: 60_000,
    staleTime: 45_000,
  });
}

export const MARKET_FUTURES_REFETCH_MS = 30_000;

export function useMarketFutures() {
  return useQuery({
    queryKey: ['market-futures-quotes'],
    queryFn: async ({ signal }): Promise<FuturesQuotesSnapshot> => {
      const r = await apiCall<FuturesQuotesResponseWire>('/api/market/futures-quotes', { signal });
      return {
        quotes: (r.quotes ?? []).map(mapQuote),
        session: r.session,
        unavailable: r.unavailable,
      };
    },
    refetchInterval: MARKET_FUTURES_REFETCH_MS,
    staleTime: 20_000,
  });
}

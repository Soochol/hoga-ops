import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import {
  EXPECTED_FILL_TTL_MS,
  useLiveTickPrices,
  type LiveExpectedSample,
  type LiveTickSample,
} from './liveTickOverlay';
import type { LiveVenueOption } from '../state/liveVenue';

export interface LiveQuote {
  code: string;
  price: number;
  change_pct: number | null;
  /** 전일대비 등락액(원). 장전(pre_open)·무데이터 시 null. */
  change_won: number | null;
  /** 당일 OHLC(멀티시세 inter2_oprc/hgpr/lwpr). **optional** — 필수면 screener·
   *  live-price-line·SectorTempStrip.test 등 범위 밖 6파일이 tsc 에러. 와이어는 항상 키를
   *  보내지만(FastAPI 전필드 직렬화) 타입은 느슨히, 호출부에서 `?? null` 강제. */
  open?: number | null;
  high?: number | null;
  low?: number | null;
  /** 검증 기준가. corporate action 방어용 adjusted daily baseline. */
  baseline_price?: number | null;
  /** 검증 기준가 날짜(YYYY-MM-DD). */
  baseline_date?: string | null;
  /** change_pct 최종 소스: kis, adjusted_daily, hidden_pre_open, unavailable. */
  change_pct_source?: string | null;
  /** quote validation warnings such as adjusted_baseline_unavailable. */
  warnings?: string[];
  stale?: boolean;
  stale_reason?: string | null;
  /** 동시호가 예상체결가/량/등락률 — WS ob 프레임(키움 0D FID 23/24)에서만 채워지는
   *  표시 전용 필드. price/change_pct 등 기존 필드는 건드리지 않는다(pre_open 의
   *  hidden_pre_open 계약 불침범). 창 밖·체결 후엔 키 자체가 없다. */
  expected_price?: number | null;
  expected_qty?: number | null;
  expected_change_pct?: number | null;
}

export interface LiveQuotesResponse {
  phase: 'pre_open' | 'open' | 'closed';
  quotes: LiveQuote[];
}

export function isStaleLiveQuote(quote: LiveQuote | undefined): boolean {
  return quote?.stale === true;
}

/** closed(평일 08:50–16:00 밖·주말)면 600s 하트비트 — `false`로 완전히 끄면
 *  React Query가 재평가할 계기가 없어 다음 개장에 폴링이 재개되지 않는다.
 *  600s는 08:50 후 최대 10분 내 자동 복귀하면서 일일 폴링 ~69% 절감
 *  (스펙 2026-06-08 ⑧ — 백엔드는 closed에 마지막 시세를 서빙하므로 셀 공백 없음). */
export function quotesRefetchInterval(phase: string | undefined): number {
  return phase === 'closed' ? 600_000 : 10_000;
}

function uniqueSortedCodes(codes: string[]): string[] {
  return [...new Set(codes)].sort();
}

export function getQuotes(codes: string[], venue: LiveVenueOption = 'KRX'): Promise<LiveQuotesResponse> {
  return apiCall<LiveQuotesResponse>(`/api/live/quotes?codes=${uniqueSortedCodes(codes).join(',')}&venue=${venue}`);
}

export function liveQuotesQueryKey(
  codes: string[],
  venue: LiveVenueOption = 'KRX',
): readonly ['live-quotes', string, LiveVenueOption] {
  return ['live-quotes', uniqueSortedCodes(codes).join(','), venue] as const;
}

/** 코드 목록의 현재가+등락률을 10초 폴링. codes 비면 비활성. */
export function useQuotes(codes: string[], venue: LiveVenueOption = 'KRX') {
  // 순서 무관 캐시 키: 관심종목 재정렬(같은 집합·다른 순서)이 queryKey 를 바꿔
  // 전 종목 시세를 불필요하게 재요청하지 않도록 정렬한 키를 쓴다. 백엔드 응답은
  // 코드 집합에만 의존하므로 요청 자체는 원래 순서 그대로 보낸다.
  return useQuery({
    queryKey: liveQuotesQueryKey(codes, venue),
    queryFn: () => getQuotes(codes, venue),
    enabled: codes.length > 0,
    staleTime: 10_000,
    refetchInterval: (q) => quotesRefetchInterval(q.state.data?.phase),
    // 전역 기본(main.tsx)은 refetchOnWindowFocus:false 다. 여기만 되살린다 —
    // 그게 없으면 마감 후 시세가 **영구히 동결**되기 때문이다:
    //   ① 탭이 hidden → refetchIntervalInBackground 기본 false 라 인터벌 정지
    //   ② 돌아와도 focus refetch 가 없어 즉시 조회 없음
    //   ③ closed 인터벌이 600s 라, 탭을 잠깐씩 확인하는 사용 패턴에서는 그
    //      타이머가 한 번도 완주하지 못하고 매번 ①로 되돌아간다
    //   ④ 장중이면 WS 틱 오버레이(liveTickOverlay)가 ①~③을 덮지만, 마감 후엔
    //      WS 연결 창(거래일 08–20시)이 닫혀 그 보완책이 없다
    // 실측 2026-08-01: 관심종목의 삼성전자가 07/31 오전 값 247,000 에 멈춰 있었고
    // (종가 262,500), 새로고침 전까지 스스로 풀리지 않았다.
    //
    // 전역에서 이걸 끈 이유(포커스 시 전 쿼리가 한꺼번에 재조회 → 백엔드 peak
    // 쿼리 폭발)는 여기서 재현되지 않는다. 되살리는 건 이 seam 하나다 — 다만
    // **쿼리 인스턴스는 하나가 아니다**: queryKey 가 코드 집합별이라 관심종목·
    // 히트맵·스크리너가 각자 하나씩 갖는다(열린 패널 수만큼, 실측 최대 3~4).
    // 그래도 감당되는 근거는 셋이다: staleTime 10s 가 포커스 연타를 흡수하고,
    // open phase 엔 어차피 같은 요청이 10s 마다 나가고 있으며, 백엔드가
    // run_with_capacity + cooldown_scope='quotes:{venue}' 로 유량을 이미 막는다.
    refetchOnWindowFocus: true,
    // codes 집합이 바뀌면 새 queryKey라 data가 잠시 undefined → 전 셀이 '—'로
    // 깜빡인다. 직전 결과를 유지해 겹치는 코드는 그대로 두고 새 코드만 채워지게
    // 한다(형제 훅 range.ts·livePastCandles.ts 와 동일 패턴).
    placeholderData: (prev) => prev,
  });
}

export interface LiveQuoteOverlay {
  /** 코드→Live Quote 조회. 없는 코드는 .get → undefined. */
  quoteByCode: Map<string, LiveQuote>;
  /** 시세 단계(pre_open/open/closed). 미도착 시 undefined. */
  phase: LiveQuotesResponse['phase'] | undefined;
  /** react-query dataUpdatedAt(ms). 미도착 시 0. */
  dataUpdatedAt: number;
}

/** 백엔드가 등락률을 계산할 때 실제로 쓴 기준가를 복원한다.
 *
 *  baseline_price(수정주가 daily baseline)를 그냥 쓰면 안 된다 — 그건 corporate
 *  action 검증용이고, quote_change_resolver 가 change_pct 를 낼 때 쓰는 값은
 *  previous_close 다(둘은 다를 수 있다). change_won = round(price - previous_close)
 *  이고 주식 가격은 정수라, price - change_won 이 그 previous_close 를 오차 없이
 *  되돌린다. 폴링값과 틱 파생값이 같은 기준선을 공유해야, 둘이 번갈아 반영돼도
 *  등락률이 튀지 않는다. change_won 이 없을 때만 baseline_price 로 폴백. */
function referenceClose(q: LiveQuote): number | null {
  if (q.price > 0 && q.change_won != null) {
    const ref = q.price - q.change_won;
    if (ref > 0) return ref;
  }
  if (q.baseline_price != null && q.baseline_price > 0) return q.baseline_price;
  return null;
}

/** 폴링 quote 에 WS 체결 표본을 덮어 등락률을 재계산한다.
 *
 *  기준가 우선순위: ① 틱이 실어 온 prevClose(키움 FID 11 유도) → ② 폴링값 역산
 *  → ③ baseline_price. ①이 1순위인 건 폴링 없이도 성립하는 유일한 경로라서다
 *  (폴링 감속·중단의 전제). ②③을 남기는 건 합성 틱·구버전 백엔드에 prevClose 가
 *  없어서이고, 실측상 ①과 ②는 같은 값을 준다(2026-07-20 5종목 전건 일치).
 *
 *  셋 다 실패하면 폴링값을 그대로 둔다 — 기준가 없이 등락률을 지어내지 않는다. */
function withTickPrice(quote: LiveQuote, tick: LiveTickSample | undefined): LiveQuote {
  if (tick === undefined) return quote;
  // 가격이 폴링값과 같고 OHLC 도 새 정보가 없으면 재계산 없이 폴링 quote 를
  // 신뢰한다. 같은 입력이라도 등락률 반올림 규칙이 갈리기 때문이다 — 백엔드
  // round()는 banker's(half-to-even), 여기 Math.round 는 half-up 이라 .xx5
  // 경계에서 끝자리가 다르고, 폴·틱 프레임이 번갈아 오면 표시가 깜빡인다.
  // 두 소스가 같은 사실을 말할 땐 한쪽(백엔드)의 표기를 단일 진실로 쓴다.
  if (tick.price === quote.price
    && (tick.dayHigh ?? quote.high) === quote.high
    && (tick.dayLow ?? quote.low) === quote.low
    && (tick.dayOpen ?? quote.open) === quote.open) {
    return quote;
  }
  const ref = tick.prevClose ?? referenceClose(quote);
  // 기준가를 못 구하면 등락률도 OHLC 도 덮지 않는다. 이 상태의 종목은 폴링값
  // 전체를 일관되게 보여주는 편이, 일부만 실시간이라 서로 어긋나는 것보다 낫다.
  if (ref === null) return quote;
  const changePct = Math.round((tick.price / ref - 1) * 10_000) / 100;
  const changeWon = Math.round(tick.price - ref);
  // 당일 OHLC 도 키움이 준다(FID 16/17/18). 없으면 폴링값 유지.
  const open = tick.dayOpen ?? quote.open;
  const high = tick.dayHigh ?? quote.high;
  const low = tick.dayLow ?? quote.low;
  // 결과가 폴링값과 동일하면 새 객체를 만들지 않는다 — 소비자 memo 가 quote
  // identity 로 재렌더를 판정하므로 무의미한 churn 을 막는다.
  if (tick.price === quote.price && changePct === quote.change_pct
    && changeWon === quote.change_won && open === quote.open
    && high === quote.high && low === quote.low) {
    return quote;
  }
  return {
    ...quote,
    price: tick.price,
    change_pct: changePct,
    change_won: changeWon,
    change_pct_source: 'ws_tick',
    open,
    high,
    low,
  };
}

/** 폴링 quote 에 동시호가 예상체결 표본을 얹는다 — withTickPrice **뒤에** 별도 적용.
 *
 *  withTickPrice 안에 넣지 않는 이유: 그 함수는 체결 틱 부재 시 첫 줄에서 반환하는데,
 *  동시호가 중엔 체결이 없어 예상가가 영원히 도달하지 못한다. 표시 조건도 phase 에
 *  걸지 않는다 — pre_open 은 KRX 선택에서만 나오고 NXT·UN 은 같은 시각에
 *  open 이라, phase 게이트면 그 둘에서 안 뜬다. 백엔드 3중 게이트가 이미 SSOT 이므로
 *  표본 존재 = 표시 조건이다.
 *
 *  예상 등락률 기준가는 referenceClose(폴링 역산 previous_close → baseline 폴백)를
 *  그대로 쓴다 — pre_open 엔 change_won=null 이라 자동으로 baseline_price(백엔드가
 *  previous_close 를 실어 주는 필드)로 떨어진다. 기준가를 못 구하면 등락률만 null 로
 *  두고 예상가는 표시한다(가격 자체는 기준가가 필요 없다). */
function withExpectedFill(
  quote: LiveQuote,
  expected: LiveExpectedSample | undefined,
  nowMs: number,
): LiveQuote {
  if (expected === undefined || nowMs - expected.seenAtMs > EXPECTED_FILL_TTL_MS) return quote;
  const ref = referenceClose(quote);
  const expectedPct = ref === null
    ? null
    : Math.round((expected.price / ref - 1) * 10_000) / 100;
  return {
    ...quote,
    expected_price: expected.price,
    expected_qty: expected.qty,
    expected_change_pct: expectedPct,
  };
}

/** unavailable 응답에 직전 등락률을 물려 깜빡임을 막는다 — 단 **일시적** 결측일
 *  때만이다(원 도입 의도: "transient response marks them unavailable").
 *
 *  price<=0 은 그 전제를 벗어난다. KIS 멀티시세는 해당 venue 에 데이터가 없으면
 *  price=0 을 센티넬로 주는데(NXT 미거래 종목 등), 이건 일시적 결측이 아니라 영구
 *  조건이라 last-good 을 적용하면 옛 등락률이 영원히 박제된다. 실제로 그 상태의
 *  행은 "가격 0 · 등락률 -4.91%" 라는 모순된 조합으로 렌더돼, 거래가 없는 종목이
 *  거래되는 것처럼 보였다. 가격이 없으면 등락률도 없는 게 정직하다 — '—' 로 둔다. */
function withLastGoodChangeFields(current: LiveQuote, previous: LiveQuote | undefined): LiveQuote {
  if (
    current.change_pct_source !== 'unavailable'
    || previous == null
    || current.change_pct !== null
    || current.price <= 0
  ) {
    return current;
  }
  return {
    ...current,
    change_pct: previous.change_pct,
    change_won: current.change_won ?? previous.change_won,
  };
}

/** Live Quote 오버레이(ADR-0056 단일 merge seam)의 deep 접근자: codes 의 현재가
 *  오버레이를 {quoteByCode, phase, dataUpdatedAt} 한 인터페이스로 노출한다. Map 조립
 *  + null-가드 + 쿼리 메타(phase·신선도)를 한 곳에 모아, 셋 다 필요한 소비자(관심맵)가
 *  인라인으로 Map 을 다시 만들지 않게 한다. Map 만 필요하면 useQuoteByCode(thin view). */
export function useLiveQuoteOverlay(codes: string[], venue: LiveVenueOption = 'KRX'): LiveQuoteOverlay {
  const q = useQuotes(codes, venue);
  // WS 체결 틱 오버레이. 10초 폴링만으로는 (1) 창이 hidden 이면 react-query 인터벌이
  // 통째로 멈추고(refetchIntervalInBackground 기본 false + main.tsx 의
  // refetchOnWindowFocus:false), (2) 주기 자체가 틱으로 움직이는 차트·호가와 어긋난다.
  // 폴링은 그대로 남는다 — 기준가 공급자이자 WS 단절·체결 공백의 폴백이다.
  const { prices: tickPrices, expected: expectedFills } = useLiveTickPrices(codes, venue);
  const lastGoodByCodeRef = useRef(new Map<string, LiveQuote>());
  // 구독 코드 집합의 안정 키. 스크리너·관심종목처럼 목록이 갈리는 소비자에서
  // last-good 캐시가 "한때 봤던 모든 코드" 로 단조 증가하던 걸 여기서 끊는다.
  const subscribedKey = uniqueSortedCodes(codes).join(',');
  // 요청 목록에서 빠진 코드의 last-good 을 버린다. 기준은 **요청 목록**이지 응답이
  // 아니다 — 응답에서 일시적으로 빠진 코드는 다음 폴링에 돌아오고 그때 폴백 근거가
  // 필요하다. 렌더가 아니라 effect 에서 하는 이유: ref 변형은 렌더 부수효과다.
  // 한 렌더 늦게 지워져도 무해하다 — 구독에서 빠진 코드는 응답에도 없어 조회되지 않는다.
  useEffect(() => {
    const subscribed = new Set(subscribedKey.split(',').filter(Boolean));
    const lastGood = lastGoodByCodeRef.current;
    for (const code of lastGood.keys()) {
      if (!subscribed.has(code)) lastGood.delete(code);
    }
  }, [subscribedKey]);
  const quoteByCode = useMemo(() => {
    const currentQuotes = q.data?.quotes;
    if (currentQuotes == null) return new Map<string, LiveQuote>();
    // TTL 판정용 시계 읽기는 useMemo 당 1회. 프레임이 끊긴 뒤의 재평가 계기는
    // 10초 REST 폴링(q.data 교체)이라, 만료 표본은 폴링 주기 안에 청소된다.
    const nowMs = Date.now();
    const next = new Map<string, LiveQuote>();
    for (const quote of currentQuotes) {
      const merged = withLastGoodChangeFields(quote, lastGoodByCodeRef.current.get(quote.code));
      // last-good 은 틱을 덮기 **전** 값으로 남긴다 — 이 캐시의 용도는 폴링이
      // unavailable 을 낼 때의 등락률 폴백이라, 틱 파생값을 섞으면 다음 폴백의
      // 근거가 흐려진다.
      lastGoodByCodeRef.current.set(quote.code, merged);
      next.set(
        quote.code,
        withExpectedFill(
          withTickPrice(merged, tickPrices.get(quote.code)),
          expectedFills.get(quote.code),
          nowMs,
        ),
      );
    }
    return next;
  }, [q.data, tickPrices, expectedFills]);
  return { quoteByCode, phase: q.data?.phase, dataUpdatedAt: q.dataUpdatedAt };
}

/** codes 의 Live Quote 를 코드→quote 조회 Map 으로 묶는다 — useLiveQuoteOverlay 의
 *  thin view. Map 만 필요한 관심종목/스크리너 패널·라이브 상태바가 쓴다(시그니처·
 *  동작·메모 안정성 불변). 없는 코드는 .get → undefined. */
export function useQuoteByCode(codes: string[], venue: LiveVenueOption = 'KRX'): Map<string, LiveQuote> {
  return useLiveQuoteOverlay(codes, venue).quoteByCode;
}

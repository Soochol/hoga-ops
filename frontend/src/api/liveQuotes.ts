import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
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
}

export interface LiveQuotesResponse {
  phase: 'pre_open' | 'open' | 'closed';
  quotes: LiveQuote[];
}

/** closed(평일 08:50–16:00 밖·주말)면 600s 하트비트 — `false`로 완전히 끄면
 *  React Query가 재평가할 계기가 없어 다음 개장에 폴링이 재개되지 않는다.
 *  600s는 08:50 후 최대 10분 내 자동 복귀하면서 일일 폴링 ~69% 절감
 *  (스펙 2026-06-08 ⑧ — 백엔드는 closed에 마지막 시세를 서빙하므로 셀 공백 없음). */
export function quotesRefetchInterval(phase: string | undefined): number {
  return phase === 'closed' ? 600_000 : 10_000;
}

export function getQuotes(codes: string[], venue: LiveVenueOption = 'KRX'): Promise<LiveQuotesResponse> {
  return apiCall<LiveQuotesResponse>(`/api/live/quotes?codes=${codes.join(',')}&venue=${venue}`);
}

export function liveQuotesQueryKey(
  codes: string[],
  venue: LiveVenueOption = 'KRX',
): readonly ['live-quotes', string, LiveVenueOption] {
  return ['live-quotes', [...codes].sort().join(','), venue] as const;
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

function withLastGoodChangeFields(current: LiveQuote, previous: LiveQuote | undefined): LiveQuote {
  if (
    current.change_pct_source !== 'unavailable'
    || previous == null
    || current.change_pct !== null
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
  const lastGoodByCodeRef = useRef(new Map<string, LiveQuote>());
  const quoteByCode = useMemo(() => {
    const currentQuotes = q.data?.quotes;
    if (currentQuotes == null) return new Map<string, LiveQuote>();
    const next = new Map<string, LiveQuote>();
    for (const quote of currentQuotes) {
      const merged = withLastGoodChangeFields(quote, lastGoodByCodeRef.current.get(quote.code));
      next.set(quote.code, merged);
      lastGoodByCodeRef.current.set(quote.code, merged);
    }
    for (const code of codes) {
      if (next.has(code)) continue;
      const previous = lastGoodByCodeRef.current.get(code);
      if (previous != null) next.set(code, previous);
    }
    return next;
  }, [codes, q.data]);
  return { quoteByCode, phase: q.data?.phase, dataUpdatedAt: q.dataUpdatedAt };
}

/** codes 의 Live Quote 를 코드→quote 조회 Map 으로 묶는다 — useLiveQuoteOverlay 의
 *  thin view. Map 만 필요한 관심종목/스크리너 패널·라이브 상태바가 쓴다(시그니처·
 *  동작·메모 안정성 불변). 없는 코드는 .get → undefined. */
export function useQuoteByCode(codes: string[], venue: LiveVenueOption = 'KRX'): Map<string, LiveQuote> {
  return useLiveQuoteOverlay(codes, venue).quoteByCode;
}

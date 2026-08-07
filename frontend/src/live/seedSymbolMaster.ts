/**
 * 테스트용 심볼 마스터 시딩 — `useEffectiveVenue` 계통이 읽는
 * `['symbols','all']` 캐시를 미리 채운다.
 *
 * **왜 필요한가.** `useLiveQuoteOverlay`·`useLiveSeries` 는 코드별 유효 venue 를
 * 해석하려고 `capture/useSymbols` 를 탄다. 시딩하지 않으면 그 훅이 실제로
 * `/api/symbols/all` 을 fetch 하는데, quotes 테스트는 대개 `apiCall` 을
 * `mockResolvedValueOnce` **큐**로 모킹하므로 심볼 요청이 그 큐를 한 칸 먹어
 * quotes 가 엉뚱한(또는 빈) 응답을 받는다. 증상이 "값이 undefined" 라 원인이
 * 안 보인다.
 *
 * `setQueryData` 는 `dataUpdatedAt` 을 지금으로 찍으므로 staleTime(1일) 안에서
 * **fetch 자체가 나가지 않는다** — 큐 순서가 보존되고 data identity 도 처음부터
 * 고정이라 resolver 가 안 흔들린다(WS 재구독 횟수를 세는 테스트가 여기 걸린다).
 *
 * 코드별 해석을 검증할 때는 `hits` 에 `nxt_enabled` 를 실어 넘긴다.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { SymbolHit } from '../api/types';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';

/** 최소 필드만 채운 `SymbolHit` — 해석에 쓰이는 건 `code`·`nxt_enabled` 뿐이다. */
export function symbolHit(code: string, nxtEnabled?: boolean | null): SymbolHit {
  return {
    code,
    name: code,
    market: 'KOSPI',
    nxt_enabled: nxtEnabled,
    captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
  };
}

export function seedSymbolMaster(qc: QueryClient, hits: SymbolHit[] = []): void {
  qc.setQueryData(SYMBOLS_QUERY_KEY, {
    symbols: hits,
    status: 'fresh',
    fetched_at_ms: 0,
  });
}

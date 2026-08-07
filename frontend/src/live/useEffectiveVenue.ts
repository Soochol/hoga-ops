/**
 * 코드별 **유효 venue** 해석 훅 — `effectiveLiveVenue`(순수 규칙)에 심볼 마스터를
 * 물려 주는 배선.
 *
 * 자료원은 `/api/symbols/all` 한 벌이고 `capture/useSymbols` 의 react-query 캐시를
 * **그대로 공유**한다(`['symbols','all']`, staleTime 1일). `/live` 는 이미
 * `LivePage.tsx` 가 이 훅을 부르므로 여기서 추가로 드는 네트워크 비용은 0 이다.
 * `util/useDocumentTitle.ts` 가 같은 방식으로 capture 모듈을 재사용하는 선례다.
 *
 * ⚠ **resolver 는 반드시 안정적인 identity 여야 한다.** 소비자
 * (`useLiveQuoteOverlay`·`useLiveTickPrices`)가 이걸 `useMemo`/`useEffect` deps 에
 * 넣기 때문이다 — 매 렌더 새 함수를 주면 quote Map 이 매번 재조립되고 WS 는 전
 * 종목을 재구독한다. 그래서 Map 은 `useMemo`, resolver 는 `useCallback` 이다.
 */
import { useCallback, useMemo } from 'react';
import { useSymbols } from '../capture/useSymbols';
import type { LiveVenueOption } from '../state/liveVenue';
import { effectiveLiveVenue } from './liveVenuePolicy';

/** 코드 → NXT 상장 여부. 마스터에 없는 코드는 `undefined`(=모름, 강등 안 함). */
export type NxtEnabledResolver = (code: string) => boolean | null | undefined;

/** 코드 → 이 종목에 실제로 쓸 venue. */
export type EffectiveVenueResolver = (code: string) => LiveVenueOption;

/** 심볼 마스터에서 코드→`nxt_enabled` 조회 함수를 만든다. 마스터 미도착이면
 *  전 코드가 `undefined` — 해석이 항등이 되어 오늘 동작과 같다. */
export function useNxtEnabledResolver(): NxtEnabledResolver {
  const { data } = useSymbols();
  const byCode = useMemo(() => {
    const map = new Map<string, boolean | null | undefined>();
    for (const hit of data?.symbols ?? []) map.set(hit.code, hit.nxt_enabled);
    return map;
  }, [data]);
  return useCallback((code: string) => byCode.get(code), [byCode]);
}

/** 선택 venue + 심볼 마스터 → 코드별 유효 venue resolver. */
export function useEffectiveVenueResolver(
  selectedVenue: LiveVenueOption,
): EffectiveVenueResolver {
  const nxtEnabled = useNxtEnabledResolver();
  return useCallback(
    (code: string) => effectiveLiveVenue(selectedVenue, nxtEnabled(code)),
    [selectedVenue, nxtEnabled],
  );
}

/** 단일 종목용 thin view. `code` 가 비면 선택 venue 그대로. */
export function useEffectiveVenue(
  code: string | null | undefined,
  selectedVenue: LiveVenueOption,
): LiveVenueOption {
  const resolve = useEffectiveVenueResolver(selectedVenue);
  return code ? resolve(code) : selectedVenue;
}

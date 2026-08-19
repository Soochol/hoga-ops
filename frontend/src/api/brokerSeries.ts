import { useQuery } from '@tanstack/react-query';

import { useEffectiveVenue } from '../live/useEffectiveVenue';
import type { LiveVenueOption } from '../state/liveVenue';
import { apiGet } from './client';
import type { BrokerSeriesEntry, BrokerSeriesResponse } from './types';

/** 거래원 궤적 캐시 보존 시간(gcTime).
 *
 * 전역 기본 30분(`main.tsx`)을 그대로 쓰지 않는다 — 페이로드가 **당일 전체** 궤적
 * (실측 2026-08-07, 003490: 16 브로커 / 14,583 점)이라 크기 등급이 다르다.
 * `/study` 5개월 저장뷰에서 커서를 가로로 훑으면 날짜 수십 벌이 각각 캐시에 남아,
 * useSpot 시절 `capacity = 6` 이 막고 있던 힙 사고(2026-07-29 크로스헤어 지연
 * 1 순위 원인)가 옷만 갈아입고 돌아온다.
 *
 * 5분이면 "종목을 다시 열면 무조건 네트워크" 는 해소되면서 상주량은 유계다.
 * 개수 상한이 아니라 시간 상한이라 등가 교환은 아니다 — 짧은 시간에 아주 많은
 * 날짜를 훑으면 여전히 쌓이므로, 그 fan-out 자체는 호출부의 디바운스가 막는다
 * (`useLiveCursor.ts` 의 `CURSOR_DATE_DEBOUNCE_MS`). 두 겹이 함께 필요하다. */
const BROKER_SERIES_GC_TIME_MS = 5 * 60_000;

/**
 * 하루치 거래원 궤적(ADR-0023) — `/live` 커서·latest 와 `/study` 가 **공유하는 단일
 * 읽기 경로**다.
 *
 * ## 왜 하나인가
 *
 * 예전엔 `useLiveBrokersAtCursor`(커서)와 `useLiveBrokersToday`(latest)가 각자
 * `useSpot` 위에 있었다. `useSpot` 의 LRU 는 **훅 인스턴스별**이라(그 파일의 계약:
 * "Different consumers do not share state") 두 훅 사이엔 dedup 이 아예 없었고,
 * 커서 스코프가 `minute-cursor` ↔ `inactive` 로 한 번 뒤집히기만 해도 **바이트
 * 단위로 같은 URL 이 두 번** 나갔다(실측 2026-08-19 `/live` 종목 전환: 58ms 와
 * 402ms 에 동일 요청 2벌). 같은 키를 공유하는 지금은 어느 경로로 들어오든 react-query
 * 가 합치므로, 그 중복이 **무엇을 트리거했는지 특정할 필요 자체가 없어진다.**
 *
 * 두 번째 이득은 재방문이다. latest 판은 갱신을 위해 캐시 키에 60초 스탬프를 박았고
 * (`useSpot` 이 키 단위 영구 캐시라 그 방법뿐이었다) 그 탓에 LRU 용량을 1 로 조여야
 * 했다 — 결과적으로 **종목을 다시 열 때마다 반드시 네트워크**였다. 여기서는 갱신을
 * `refetchInterval` 이 맡으므로 키가 안정적이고, 재방문은 `gcTime` 안에서 캐시 히트다.
 *
 * ## venue 해석을 이 훅이 삼킨다
 *
 * 호출부는 **사용자 선택값**을 그대로 넘긴다. 코드별 유효 venue 해석
 * (`useEffectiveVenue`)은 여기서 한 번만 한다 — 소비 표면마다 각자 해석하게 두면
 * 한 곳이 빠지고, 그게 실제 사고였다(#1209 후속: NXT 미상장 종목에 통합(UN)을
 * 고르면 백엔드가 만든 적 없는 `kiwoom_live/UN/` 을 읽어 창이 조용히 빈다. 부재는
 * 500 이 아니라 **빈 200** 이라 증상이 조용하다). 근거·실측은 `useLiveCursor.ts`
 * 의 `VenueParam` 주석.
 *
 * 캐시 키에도 **해석한 값**이 들어간다. 선택값으로 키를 잡으면 미상장 종목에서
 * KRX 와 UN 이 같은 응답을 서로 다른 키에 두 벌 담는다.
 *
 * ## 반환
 *
 * 궤적 배열, 또는 아직 없으면 `undefined`. 호출부는 `undefined`(로딩)와 `[]`
 * (거래원 없음)를 구분해서 쓴다 — `resolveBrokerCardProps` 참조.
 */
export function useBrokerSeriesForDay({
  code,
  date,
  sourcePref,
  venue,
  liveRefreshMs,
}: {
  code: string | null;
  /** 조회할 거래일(`YYYYMMDD`). `null` 이면 잠든다. */
  date: string | null;
  /** `useOrderflowSourcePref()` 값. 로딩 중(`undefined`)이면 조회하지 않는다 —
   *  기본값으로 한 번 받고 해소된 뒤 다시 받으면 콜드 마운트에서 화면이 스왑된다. */
  sourcePref: string | undefined;
  /** **사용자 선택** venue. 해석은 이 훅이 한다(위 docstring). */
  venue: LiveVenueOption;
  /** 이 날짜가 아직 자라는가.
   *
   *  오늘분이면 갱신 주기(ms) — 백엔드 Today Promotion 이 주기적으로
   *  `brokers.parquet` 을 다시 쓴다. 과거 날짜면 `null` = 불변이므로 한 번 받고
   *  동결한다(캡처된 Stock-Date 는 immutable). */
  liveRefreshMs: number | null;
}): BrokerSeriesEntry[] | undefined {
  // code=null 이어도 해석은 항등이라 무조건 부른다 — 훅 순서를 고정해야 한다.
  const effectiveVenue = useEffectiveVenue(code, venue);
  const { data } = useQuery({
    queryKey: ['brokers/series', code, date, sourcePref, effectiveVenue] as const,
    queryFn: () =>
      apiGet<BrokerSeriesResponse>(
        `/api/brokers/series?code=${code}&date=${date}&source_pref=${sourcePref}&venue=${effectiveVenue}`,
      ),
    select: (r) => r.brokers,
    enabled: code !== null && date !== null && sourcePref !== undefined,
    // 자라는 날짜는 주기만큼만 신선하고, 과거 날짜는 영원히 신선하다. 두 값이
    // 한 노브에서 파생되므로 "staleTime 은 무한인데 refetchInterval 은 돈다"
    // 같은 모순 조합이 애초에 표현되지 않는다.
    staleTime: liveRefreshMs ?? Infinity,
    refetchInterval: liveRefreshMs ?? false,
    gcTime: BROKER_SERIES_GC_TIME_MS,
  });
  return data;
}

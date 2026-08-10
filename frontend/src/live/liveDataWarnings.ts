/**
 * /live 과거 데이터 fetch 경고 분류 (2026-06-09).
 *
 * past-candles(분봉)·past-daily-candles(D/W/M)·investor-net 응답은 모두
 * `data_warnings: { reason, msg, ... }[]` 를 내려준다. 세 경로가 같은 분류를 쓰도록
 * (DRY) 여기 한 곳에서만 reason→의미 매핑을 한다.
 *
 * **각 경로의 `reason` 타입은 제각각이고 이 파일은 일부러 `string` 을 받는다.**
 * 분봉은 미러 자체가 느슨한 `string` 이고, daily 는 닫힌 유니온이며(그래서
 * `livePastDailyCandles.ts` 가 실제 방출값 목록을 소유한다), investor 는 백엔드가
 * `_reason_for` 로 좁혀서 보낸다. 값 목록을 여기 다시 적으면 세 벌이 되어 반드시
 * 갈리므로 적지 않는다 — 실제로 daily 유니온에서 `transport_error` 가 오래 빠져
 * 있었고 이 파일이 `string` 을 받은 덕에 런타임만 멀쩡했다(#1226).
 *
 * 소비처: useLiveBundle이 활성 타임프레임 경로의 경고를 골라 summarize하고,
 * LiveChartRoot가 (1) candles==0 && hasRateLimit → 빈칸 문구를 "호출 한도로 지연"으로,
 * (2) candles>0 && count>0 → 비차단 "일부 과거구간 로딩 지연" 칩으로 표시한다.
 * 캔들이 0 이면서 벤더가 거절한 경우는 `candleEmptyState` 가 따로 소유한다.
 */

import { warningKind, type WireDataWarning } from '../api/dataWarnings';

/** 세 경로 경고의 공통 최소 형태. 진단 축은 `WireDataWarning` 이 소유한다. */
export type LiveDataWarning = WireDataWarning;

/**
 * 유량 한도로 인한 지연/중단 경고인가? — **백엔드가 실은 `kind` 로 판정한다**(ADR-0143).
 *
 * 이관 전에는 사유 집합(`rate_limit_upstream` · `rate_limit_aborted`)을 프론트가
 * 들고 있었다. 같은 사실의 6벌 중 하나였고, #1251 이 그 부류의 사고였다.
 *
 * **동작은 동등하다.** 백엔드 분류표에서 `rate_limit` 인 사유가 정확히 그 둘이다.
 * `capacity_overloaded` 는 같은 PR 에서 `deferred` 로 고쳤다 — 큐 포화는 우리 쪽이라
 * "호출 한도" 문구가 거짓이 되기 때문이고, 이관 전 이 집합에도 없었다.
 */
export function isRateLimitWarning(warning: LiveDataWarning): boolean {
  return warningKind(warning) === 'rate_limit';
}

export interface WarningSummary {
  /** 경고 총 개수 (>0 → 부분 로딩 칩 트리거). */
  count: number;
  /** rate-limit 계열 경고가 하나라도 있나 (빈칸 문구 전환 트리거). */
  hasRateLimit: boolean;
  /** 첫 경고의 벤더 원문(`msg`). 칩 툴팁 전용 — **분기 조건으로 쓰지 말 것.**
   * 동작은 `reason` 으로만 가른다(`reason` 은 계약, `msg` 는 사람이 읽는 산문이라
   * 벤더가 예고 없이 바꾼다).
   *
   * 이걸 노출하는 이유: 칩 문구는 rate-limit 여부 2분류라 원인이 전혀 안 보인다.
   * 2026-08-04 에 키움 토큰이 벤더 측에서 무효화(8005)돼 과거 캔들이 통째로 멎었을
   * 때, 화면만으로는 진단이 **불가능**해서 백엔드 응답을 직접 떠야 했다. */
  firstMsg: string | null;
}

/** 경고 배열을 표시용 요약으로 접는다. null/빈 배열은 무경고. */
export function summarizeWarnings(
  warnings: readonly LiveDataWarning[] | null | undefined,
): WarningSummary {
  if (!warnings || warnings.length === 0) {
    return { count: 0, hasRateLimit: false, firstMsg: null };
  }
  return {
    count: warnings.length,
    hasRateLimit: warnings.some(isRateLimitWarning),
    firstMsg: warnings.find((w) => w.msg)?.msg ?? null,
  };
}

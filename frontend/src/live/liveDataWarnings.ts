/**
 * /live 과거 데이터 fetch 경고 분류 (2026-06-09).
 *
 * past-candles(분봉)·past-daily-candles(D/W/M)·investor-net 응답은 모두
 * `data_warnings: { reason, msg, ... }[]` 를 내려준다. reason은 past-candles 쪽이
 * 느슨한 `string`(백엔드가 `rate_limit_upstream` | `rate_limit_aborted` | `api_error`
 * | `cache_write_failed` 방출), daily/investor 쪽이 `'rate_limit_upstream' |
 * 'api_error' | 'invariant_violation'` 유니온. 세 경로가 같은 분류를 쓰도록
 * (DRY) 여기 한 곳에서만 reason→의미 매핑을 한다.
 *
 * 소비처: useLiveBundle이 활성 타임프레임 경로의 경고를 골라 summarize하고,
 * LiveChartRoot가 (1) candles==0 && hasRateLimit → 빈칸 문구를 "호출 한도로 지연"으로,
 * (2) candles>0 && count>0 → 비차단 "일부 과거구간 로딩 지연" 칩으로 표시한다.
 */

/** 세 경로 경고의 공통 최소 형태 — 분류에 필요한 `reason`만 본다. */
export interface LiveDataWarning {
  reason: string;
  msg?: string;
}

/** KIS 초당 한도(EGW00201)로 인한 지연/중단 경고인가?
 * - `rate_limit_upstream`: 재시도(_rate_limit_backoff) 소진 후 그 날짜 fetch 실패.
 * - `rate_limit_aborted`: 앞 날짜가 한도에 막혀(`blocked`) 후속 날짜를 KIS 안 두드리고 중단.
 * 나머지(`api_error`/`invariant_violation`/`cache_write_failed`)는
 * rate-limit 아님. */
const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set(['rate_limit_upstream', 'rate_limit_aborted']);
export function isRateLimitReason(reason: string): boolean {
  return RATE_LIMIT_REASONS.has(reason);
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
    hasRateLimit: warnings.some((w) => isRateLimitReason(w.reason)),
    firstMsg: warnings.find((w) => w.msg)?.msg ?? null,
  };
}

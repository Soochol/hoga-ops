/**
 * 장중 오버레이 강등 사유 → 사용자 문구 (ADR-0137 R6).
 *
 * 백엔드는 예외를 `error_policy` 로 분류해 `intraday_<reason>` 을 warnings 에 싣는다.
 * 이 모듈이 그 사유를 **처방이 드러나는 문장**으로 번역한다 — 유량 초과("잠시 후
 * 재조회")와 자격증명 부재("설정 확인")는 사용자가 할 일이 다르기 때문이다.
 *
 * 두 소비처(`/screener` 페이지 · 우측 드로어)가 같은 문구를 쓰도록 여기 한 곳에서만
 * 매핑한다. 이전에는 두 곳이 각자 `intraday_fallback_eod` 하나만 검사해 유량 초과·
 * 자격증명 부재·파싱 오류가 전부 "장중 조회 불가" 로 뭉개졌다(ADR-0137).
 *
 * **미등록 사유를 조용히 버리지 않는다.** 백엔드가 새 사유를 추가했는데 여기 매핑이
 * 없으면 화이트리스트 렌더는 그것을 없었던 일로 만든다 — 백엔드가 내보내던 사유
 * 45개 중 9개가 그렇게 UI 에 도달하지 못한다. 못생긴 표시가 침묵보다 낫다.
 */

interface ReasonCopy {
  /** 무엇이 일어났나 — 문장 앞머리에 온다. */
  cause: string;
  /** 사용자가 할 일. 재시도가 의미 없는 사유(permanent)에는 붙이지 않는다. */
  hint?: string;
}

const REASON_COPY: Record<string, ReasonCopy> = {
  intraday_rate_limit_upstream: { cause: '호출 한도 초과', hint: '잠시 후 다시 조회하세요' },
  // 배치 상한은 재시도가 아니라 **범위 축소**가 답이다(키움 1634).
  intraday_batch_limit_exceeded: { cause: '조회 상한 초과', hint: '종목 범위를 좁혀 주세요' },
  intraday_credentials_missing: { cause: 'API 자격증명 없음' },
  intraday_auth_error: { cause: 'API 인증 실패', hint: '자격증명을 확인하세요' },
  intraday_transport_error: { cause: '시세 서버 연결 실패', hint: '잠시 후 다시 조회하세요' },
  intraday_api_error: { cause: '시세 서버 오류', hint: '잠시 후 다시 조회하세요' },
  intraday_internal_processing_error: { cause: '장중 시세 처리 오류' },
  intraday_unexpected_error: { cause: '장중 시세 처리 오류' },
};

/** 사유 코드가 아니라 상태를 뜻하는 것들 — 원인 후보에서 제외한다. */
const NON_CAUSE_WARNINGS: ReadonlySet<string> = new Set([
  'intraday_fallback_eod',
  'intraday_partial',
  'intraday_quote_invalid',
  'intraday_volume_unavailable',
]);

const FALLBACK_SUFFIX = '전일 확정 데이터로 표시 중';

function resolveCause(warnings: readonly string[]): ReasonCopy | null {
  for (const warning of warnings) {
    const copy = REASON_COPY[warning];
    if (copy) return copy;
  }
  const unmapped = warnings.find(
    (w) => w.startsWith('intraday_') && !NON_CAUSE_WARNINGS.has(w) && !REASON_COPY[w],
  );
  return unmapped ? { cause: `장중 조회 불가(${unmapped})` } : null;
}

/**
 * 강등 배너 문구. 강등이 없으면 null.
 *
 * 우선순위: 부분 성공 > 전량 폴백. 부분 성공은 결과의 일부가 실제 장중 값이므로
 * "조회 불가" 로 말하면 거짓이 된다.
 */
export function intradayDegradationText(warnings: readonly string[] | null | undefined): string | null {
  if (!warnings || warnings.length === 0) return null;
  const cause = resolveCause(warnings);

  if (warnings.includes('intraday_partial')) {
    const because = cause ? ` · ${cause.cause}` : '';
    return `일부 종목만 장중 반영${because} · 나머지는 ${FALLBACK_SUFFIX}`;
  }
  if (!warnings.includes('intraday_fallback_eod') && !cause) return null;
  if (!cause) return `장중 조회 불가 · ${FALLBACK_SUFFIX}`;
  return [`${cause.cause} · ${FALLBACK_SUFFIX}`, cause.hint].filter(Boolean).join(' · ');
}

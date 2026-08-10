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

import { warningKind, type LiveWarningKind, type WireDataWarning } from '../api/dataWarnings';
import { WARNING_CAUSE } from '../api/warningCopy';

interface ReasonCopy {
  /** 무엇이 일어났나 — 문장 앞머리에 온다. */
  cause: string;
  /** 사용자가 할 일. 재시도가 의미 없는 사유(permanent)에는 붙이지 않는다. */
  hint?: string;
}

/**
 * kind → 문구 (ADR-0143 이관). 이전에는 `intraday_` 접두를 붙인 **사유별** 표였다.
 *
 * 접두는 백엔드가 벗겼다 — 사유가 상태 태그 배열과 한 평면에 섞여 있어서 붙었던
 * 것인데, 이제 `intraday_failure` 라는 자체 필드로 오므로 충돌할 이름이 없다.
 *
 * 문구는 이관 전과 **1:1로 같다**: `rate_limit_upstream`→rate_limit ·
 * `batch_limit_exceeded`→batch_limit · `credentials_missing`→not_wired ·
 * `auth_error`→auth · `transport_error`→transport · `api_error`→vendor_api ·
 * `internal_processing_error`→internal · `unexpected_error`→unexpected.
 * 사유 8개가 kind 8개로 흩어지지 않고 정확히 대응한다.
 */
const KIND_COPY: Partial<Record<LiveWarningKind, ReasonCopy>> = {
  rate_limit: { cause: WARNING_CAUSE.rate_limit, hint: '잠시 후 다시 조회하세요' },
  // 배치 상한은 재시도가 아니라 **범위 축소**가 답이다(키움 1634).
  batch_limit: { cause: '조회 상한 초과', hint: '종목 범위를 좁혀 주세요' },
  // 자격증명 부재 — 앱 설정 문제라 `auth`(벤더 쪽 등록)와 처방이 다르다.
  not_wired: { cause: 'API 자격증명 없음' },
  auth: { cause: 'API 인증 실패', hint: '자격증명을 확인하세요' },
  // 원인 명사구는 표면 공통 사전에서 온다 — 예전엔 여기가 '연결 실패' 라
  // 같은 kind 를 `/live` 토스트('연결 불가')와 다른 이름으로 불렀다.
  transport: { cause: WARNING_CAUSE.transport, hint: '잠시 후 다시 조회하세요' },
  vendor_api: { cause: '시세 서버 오류', hint: '잠시 후 다시 조회하세요' },
  internal: { cause: '장중 시세 처리 오류' },
  unexpected: { cause: '장중 시세 처리 오류' },
  // 우리 쪽 유예 — 벤더는 거절한 적이 없다.
  deferred: { cause: '요청이 밀려 지연', hint: '잠시 후 다시 조회하세요' },
  data_quality: { cause: '장중 시세 처리 오류' },
};

/** 사유 코드가 아니라 상태를 뜻하는 것들 — 원인 후보에서 제외한다. */
const NON_CAUSE_WARNINGS: ReadonlySet<string> = new Set([
  'intraday_fallback_eod',
  'intraday_partial',
  'intraday_quote_invalid',
  'intraday_volume_unavailable',
]);

const FALLBACK_SUFFIX = '전일 확정 데이터로 표시 중';

function resolveCause(
  warnings: readonly string[],
  failure: WireDataWarning | null | undefined,
): ReasonCopy | null {
  const kind = failure ? warningKind(failure) : undefined;
  if (kind) {
    const copy = KIND_COPY[kind];
    // 미등록 kind 도 조용히 버리지 않는다 — 백엔드가 kind 를 늘렸는데 여기 매핑이
    // 없으면 화이트리스트 렌더가 그것을 없었던 일로 만든다.
    return copy ?? { cause: `장중 조회 불가(${kind})` };
  }
  // 사유는 있는데 kind 가 없는 경우 — 백엔드가 아직 안 실었거나(배포 직후 캐시)
  // 정보성 경고다. 최소한 사유는 보여 준다.
  if (failure?.reason) return { cause: `장중 조회 불가(${failure.reason})` };
  // 접두 사유가 상태 배열에 섞여 오던 옛 응답의 잔재(gcTime 캐시). 못생긴 표시가
  // 침묵보다 낫다는 원칙은 그대로다.
  const unmapped = warnings.find(
    (w) => w.startsWith('intraday_') && !NON_CAUSE_WARNINGS.has(w),
  );
  return unmapped ? { cause: `장중 조회 불가(${unmapped})` } : null;
}

/**
 * 강등 배너 문구. 강등이 없으면 null.
 *
 * 우선순위: 부분 성공 > 전량 폴백. 부분 성공은 결과의 일부가 실제 장중 값이므로
 * "조회 불가" 로 말하면 거짓이 된다.
 */
export function intradayDegradationText(
  warnings: readonly string[] | null | undefined,
  failure?: WireDataWarning | null,
): string | null {
  if ((!warnings || warnings.length === 0) && !failure) return null;
  const cause = resolveCause(warnings ?? [], failure);
  if (!warnings || warnings.length === 0) {
    // 상태 태그 없이 사유만 온 경우 — 전량 폴백 문장으로 낸다(오버레이가 통째로
    // 실패하면 `intraday_fallback_eod` 는 runner 가 붙이지만, 순서에 의존하지 않는다).
    return cause ? [`${cause.cause} · ${FALLBACK_SUFFIX}`, cause.hint].filter(Boolean).join(' · ') : null;
  }

  if (warnings.includes('intraday_partial')) {
    const because = cause ? ` · ${cause.cause}` : '';
    return `일부 종목만 장중 반영${because} · 나머지는 ${FALLBACK_SUFFIX}`;
  }
  if (!warnings.includes('intraday_fallback_eod') && !cause) return null;
  if (!cause) return `장중 조회 불가 · ${FALLBACK_SUFFIX}`;
  return [`${cause.cause} · ${FALLBACK_SUFFIX}`, cause.hint].filter(Boolean).join(' · ');
}

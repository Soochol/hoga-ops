/**
 * wire `data_warnings` 항목의 공통 shape 과 **진단 축** (ADR-0143).
 *
 * ## 왜 이 파일이 생겼나
 *
 * 백엔드 `error_policy` 는 실패마다 성격을 계산하는데 wire 로는 `reason` 과 `msg` 만
 * 나갔다. 그래서 프론트 **6개 모듈이 그 사실을 `reason` 문자열로부터 각자 역추론**
 * 했고, 그중 하나가 갈린 것이 #1251 이었다(전송 실패가 non-blocking 으로 분류돼
 * 재시도·박제·재발행 가드를 한꺼번에 통과).
 *
 * 이제 백엔드가 `kind` 와 `is_failure` 를 실어 보낸다(`hoga/live/data_warnings.py`).
 * 이 모듈이 그것을 읽는 유일한 입구이고, 역추론 표들은 여기로 이관되어 사라진다.
 *
 * ## 두 축은 직교한다
 *
 * `data_warnings` 는 실패 전용 채널이 아니다. `rest_bypassed`(모드 안내) ·
 * `*_fallback_to_krx`(대체 **성공**) · `index_minute_depth_limited`(벤더 보유의 사실)은
 * 실패가 아닌데 같은 배열로 온다. 그래서 **정보성은 `kind` 가 없고 `is_failure=false`**
 * 다 — kind 는 실패의 처방 부류를 묶는 축이라 실패에만 붙는다.
 */

/** 백엔드 `LiveErrorKind` 의 손 미러(ADR-0004). 정보성 경고에는 없다. */
export type LiveWarningKind =
  | 'transport'
  | 'rate_limit'
  | 'batch_limit'
  | 'auth'
  | 'vendor_api'
  | 'internal'
  | 'unexpected'
  // 벤더에게 **묻지도 않았다** — 우리 쪽 예산·큐 포화. `rate_limit` 과 갈라 두는
  // 이유는 문구가 거짓이 되기 때문이다("호출 한도" 는 벤더가 거절했다는 뜻이다).
  | 'deferred'
  // 받긴 받았는데 행 검증에 걸렸다(ADR-0020: 표시하되 렌더).
  | 'data_quality';

/** 세 경로(분봉·일봉·지수)가 공유하는 최소 shape. 분기는 이 필드들로만 한다. */
export interface WireDataWarning {
  reason: string;
  msg?: string;
  kind?: LiveWarningKind;
  is_failure?: boolean;
}

/** 실패의 처방 부류. 정보성이거나 백엔드가 아직 안 실었으면 `undefined`. */
export function warningKind(warning: WireDataWarning): LiveWarningKind | undefined {
  return warning.kind;
}

/**
 * 이 경고가 **실패**인가. 부재 시 `true` 로 기운다.
 *
 * 부재가 생기는 경우는 하나뿐이다 — 이 필드가 생기기 전에 캐시된 응답이 React Query
 * gcTime(2h) 안에 남아 있는 배포 직후 구간. 그 창에서 정보성이 실패로 보이면 사용자가
 * 한 번 놀라고 말지만, 반대(실패가 정보성으로 보임)면 **조용히 사라진다** —
 * #1251 이 정확히 그 방향의 사고였다.
 */
export function isWarningFailure(warning: WireDataWarning): boolean {
  return warning.is_failure ?? true;
}

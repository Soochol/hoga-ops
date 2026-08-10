import type { ApiError } from '../api/client';
import { warningKind, type LiveWarningKind, type WireDataWarning } from '../api/dataWarnings';

/**
 * 캔들이 없을 때 **왜 없는지** — 원인 4종 판별 (#1133 후속).
 *
 * 지금까지 넷이 전부 같은 화면이었다: 아무 설명 없는 빈 차트. 원인이 다르면 사용자가
 * 할 일도 다른데(키 등록 / 재시도 / 설정 되돌리기 / 아무것도), 화면이 그걸 구별해 주지
 * 않아 무엇을 고쳐야 할지 알 수 없었다.
 *
 * **호가 결손과 성격이 정반대라 따로 둔다**(`hogaMissingNotice`). 호가 결손은 그 순간
 * 받아 두지 않으면 영원히 없는 데이터라 "받아들이세요" 이고, 캔들 결손은 벤더가 과거를
 * 언제든 다시 주므로 **대개 고칠 수 있다**. 그래서 이쪽만 행동을 제안한다.
 *
 * 판별 근거는 **두 갈래**다.
 *
 * (1) HTTP 에러 코드(`hoga/api/error_codes.py::LiveErrorCode`):
 *   - `not_wired` (503) — 자격증명 미설정 등 의존성 미배선. remediation 이 "설정하거나
 *     재시작" 하나라 코드도 하나다(그 파일 주석의 판정 기준).
 *   - `kiwoom_api_error` · `kiwoom_http_error` (502) — 벤더 업스트림. 재시도가 답이다.
 *
 * (2) 200 응답의 `data_warnings` — **이쪽이 실제로 더 흔하다.** 일봉 walkback 은
 *     벤더 실패를 500 으로 올리지 않고 경고로 강등하므로(#1226), `error` 가 null 인데
 *     캔들만 0 인 상태가 정상 경로로 생긴다. 경고를 안 보면 그 화면이 "이 구간에
 *     캔들이 없다" 로 떠서 **벤더가 거절한 것을 없는 데이터라고 단언**하게 된다.
 */

/** 무엇을 할 수 있나. `null` 이면 사용자가 할 일이 없다(정보만). */
export type CandleEmptyAction = 'settings' | 'retry' | null;

export interface CandleEmptyState {
  /** 한 줄 설명 — DESIGN.md 빈 상태 규약("한 줄 + 행동 1개"). */
  text: string;
  action: CandleEmptyAction;
  /** 행동 버튼 라벨. `action` 이 null 이면 없다. */
  actionLabel?: string;
  /**
   * 벤더 원문(있을 때). 한 줄 규약을 지키면서 진단 근거를 손 닿는 곳에 두려고
   * **툴팁으로만** 노출한다 — 부분로딩 칩의 `title` 과 같은 처방이다.
   *
   * 이게 없으면 인증 실패의 진짜 코드(`8050` vs `8005`)를 화면에서 구별할 수 없다.
   * 둘은 고칠 곳이 다르다(단말기 등록 vs 토큰/앱키).
   */
  detail?: string;
}

export interface CandleEmptyInput {
  /** 현재 활성 캔들 소스의 에러(타임프레임·우회 설정에 따라 다른 쿼리다). */
  error: unknown;
  /**
   * 활성 경로의 `data_warnings`. **200 인데 캔들이 비는 경우의 유일한 단서다.**
   *
   * 백엔드는 벤더 실패를 500 이 아니라 경고로 강등한다(#1226 이후 오늘 프로브까지).
   * 그래서 `error` 는 null 인데 캔들이 0 인 상태가 정상 경로로 생기고, 경고를 안 보면
   * 그 화면이 "이 구간에 캔들이 없다" 로 뜬다 — 벤더가 거절한 것을 **없는 데이터라고
   * 단언**하는 셈이라 에러를 삼키는 것보다 나쁘다.
   */
  warnings?: readonly WireDataWarning[];
  /** 이 창이 지금 캔들을 하나라도 그리고 있나. */
  hasCandles: boolean;
  /** 로딩 중엔 판단하지 않는다 — 안 그러면 매 조회마다 빈 상태가 깜빡인다. */
  isLoading: boolean;
  /** REST 우회(디스크 전용 모드). 켜져 있으면 벤더가 아니라 디스크가 원인이다. */
  restBypassEnabled: boolean;
  /** 종목이 아예 안 골라졌으면 이 안내의 대상이 아니다(그건 별도 빈 상태). */
  hasInstrument: boolean;
}

function errorCode(error: unknown): string | undefined {
  return (error as ApiError | undefined)?.code;
}

/**
 * "벤더가 못 줬다" 를 뜻하는 **kind 들** — 허용목록이다(ADR-0143 이관).
 *
 * 이관 전에는 사유 문자열 5개 집합이었다. kind 로 바꿔도 **완전히 동등하다**:
 * `rate_limit_upstream`·`rate_limit_aborted`→`rate_limit`, `transport_error`→
 * `transport`, `api_error`→`vendor_api`, `batch_limit_exceeded`→`batch_limit`.
 *
 * 제외목록이 아닌 이유는 그대로다: `rest_bypassed`(우회 켜짐)와 `invariant_violation`
 * (행 단위 검증 실패)은 벤더 실패가 아니고, 이 목록에 새는 순간 그 아래 우회 안내
 * 분기가 도달 불가가 된다. 백엔드가 kind 를 늘릴 때 여기 추가하지 않으면 최악이
 * "예전처럼 일반 문구" 인 반면, 제외목록이면 최악이 "엉뚱한 안내" 라 방향이 다르다.
 */
const VENDOR_FAILURE_KINDS: ReadonlySet<LiveWarningKind> = new Set([
  'rate_limit',
  'transport',
  'vendor_api',
  'batch_limit',
]);

/**
 * **벤더에게 묻지도 않은** 실패 — 우리 쪽 유예다(`deferred` kind).
 *
 * 위와 갈라 두는 이유는 문구가 거짓이 되기 때문이다. `capacity_overloaded` 는 우리
 * 스케줄러 대기열이 찬 것이고 `fetch_budget_exhausted` 는 우리가 요청당 상한을 걸어
 * 오래된 날짜를 **다음 사이클로 미룬** 것이다. 둘 다 벤더는 이 구간을 거절한 적이
 * 없으므로 "벤더가 주지 않았다" 로 말하면 묻지도 않은 쪽에 책임을 지우게 된다.
 *
 * **이 구분이 백엔드 kind 로 승격됐다** — `capacity_overloaded` 의 wire kind 가
 * `deferred` 인 것은 여기 있던 판정을 그대로 옮긴 것이다(#1254).
 *
 * 행동은 재시도를 준다. 폴링이 도는 장중에는 스스로 이어받지만, 폴링이 멈추는
 * 장외(`liveVenueRefetchInterval` 이 false)에서는 저절로 낫지 않아 빈 차트가 그대로
 * 남는다 — 그 구간에서 유일하게 듣는 손잡이다. "없는 버튼이 낫다" 규칙은 **누를 수
 * 없는** 버튼에 대한 것이고, 이건 실제로 듣는다.
 */
const DEFERRED_FETCH_KIND: LiveWarningKind = 'deferred';

/**
 * 표시할 빈 상태. 캔들이 있거나 판단할 수 없으면 `null`.
 *
 * 순서가 계약이다 — **에러가 먼저**다. 에러가 있으면 캔들이 없는 이유가 그것이고,
 * 그 아래 분기(우회/데이터 없음)는 "정상적으로 조회했는데 없다" 를 뜻하기 때문이다.
 */
export function deriveCandleEmptyState({
  error,
  warnings,
  hasCandles,
  isLoading,
  restBypassEnabled,
  hasInstrument,
}: CandleEmptyInput): CandleEmptyState | null {
  if (!hasInstrument || hasCandles || isLoading) return null;

  const code = errorCode(error);
  if (code === 'not_wired') {
    return {
      text: '벤더 연결이 설정되지 않아 캔들을 받지 못했다',
      action: 'settings',
      actionLabel: '설정 열기',
    };
  }
  if (code === 'kiwoom_api_error' || code === 'kiwoom_http_error') {
    return { text: '벤더 응답이 없어 캔들을 받지 못했다', action: 'retry', actionLabel: '다시 시도' };
  }
  if (error) {
    // 알 수 없는 실패 — 코드를 못 읽어도 "조회가 실패했다" 는 말할 수 있다. 원인을
    // 모른다고 침묵하면 사용자는 다시 빈 차트만 본다.
    return { text: '캔들을 불러오지 못했다', action: 'retry', actionLabel: '다시 시도' };
  }

  // 200 + 경고 — 벤더가 거절했지만 백엔드가 경고로 강등한 경로다. 에러 분기 **뒤**,
  // 우회/데이터없음 분기 **앞**이 자리다: 여기까지 왔다는 건 조회가 형식상 성공했다는
  // 뜻이고, 그래도 경고가 있으면 "없는 데이터" 가 아니라 "못 받은 데이터"다.
  const authWarning = warnings?.find((w) => warningKind(w) === 'auth');
  if (authWarning) {
    // **행동을 제안하지 않는다.** 앱 설정 모달로는 못 고친다 — 인증 실패의 처방은
    // 벤더 쪽(단말기·IP 등록)이거나 앱키 재발급이라 이 앱 안에 버튼이 없다. 재시도는
    // 더 나쁘다: 설정을 고치기 전에는 영원히 같은 실패라 누를수록 헛돈다.
    // 원문은 `detail` 로 넘겨 어느 코드인지 hover 로 확인할 수 있게 한다.
    return { text: '벤더 인증에 실패해 캔들을 받지 못했다', action: null, detail: authWarning.msg };
  }
  const vendorWarning = warnings?.find((w) => {
    const kind = warningKind(w);
    return kind !== undefined && VENDOR_FAILURE_KINDS.has(kind);
  });
  if (vendorWarning) {
    return {
      text: '벤더가 이 구간을 주지 않았다',
      action: 'retry',
      actionLabel: '다시 시도',
      detail: vendorWarning.msg,
    };
  }
  // 벤더 실패보다 **뒤**다 — 둘이 섞여 오면 상류 거절 쪽이 더 알려 줄 것이 많다.
  const deferredWarning = warnings?.find((w) => warningKind(w) === DEFERRED_FETCH_KIND);
  if (deferredWarning) {
    return {
      text: '요청이 밀려 이 구간을 아직 받지 못했다',
      action: 'retry',
      actionLabel: '다시 시도',
      detail: deferredWarning.msg,
    };
  }

  if (restBypassEnabled) {
    // 조회는 성공했는데 비었다 + 디스크 전용 모드 = 이 구간이 저장되지 않은 것이다.
    // 벤더를 켜면(우회 끄기) 받아올 수 있으므로 그쪽으로 안내한다.
    return {
      text: '저장된 캔들이 없는 구간이다 · 벤더 우회가 켜져 있다',
      action: 'settings',
      actionLabel: '설정 열기',
    };
  }
  // 벤더가 정상 응답했는데 비었다 = 그 시장·그 기간에 캔들이 없다. 고칠 것이 없으므로
  // 행동을 제안하지 않는다 — 없는 버튼이 있는 버튼보다 정직하다.
  return { text: '이 구간에 캔들이 없다', action: null };
}

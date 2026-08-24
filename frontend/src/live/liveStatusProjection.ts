import { authFailingKiwoomKeys, type CaptureReason, type LiveStatus } from '../api/liveStatus';
import { useWatchlist } from '../watchlist/useWatchlist';

export type LiveBannerCause =
  | 'watchlist_empty'
  | 'kis_token_expired'
  | 'kiwoom_auth_failing'
  | 'realtime_unavailable';

/** 헤더 밴드에 렌더되는 우선순위-1 배너 값(액션 링크 동반). 세 소비처
 * (projection·bannerState·LiveStateBanner Props)가 이 타입 하나를 공유한다 —
 * 멤버 추가 시 lockstep(CONTEXT.md STATE_SEVERITY SSOT 규율). */
export type LiveBannerPrimary =
  | 'watchlist_empty'
  | 'realtime_unavailable'
  | null;

export type InventoryState =
  | { kind: 'watchlist'; size: number | null }
  | { kind: 'heatmap'; size: number | null }
  | { kind: 'unknown' };

/**
 * 캡처 헬스 pill 의 등급. **2단이다** — 예전엔 `'warn'` 이 있었지만 그 등급으로 가는
 * 유일한 길이 `reconnecting`·`subscribing` 이었고, 두 reason 은 ADR-0118 PR-G
 * (KIS WS 계층 삭제)에서 백엔드가 내보내기를 멈춘 뒤로 도달 불가였다. 타입에만 남은
 * 등급은 "3단계 상태 기계" 라는 거짓 문서가 되므로 지웠다 — 다시 필요해지면
 * `CAPTURE_REASON_VIEW` 에 warn 을 쓰는 reason 을 추가하면서 같이 되살린다.
 */
export type CaptureHealthSeverity = 'ok' | 'error';

export interface CaptureHealthView {
  severity: CaptureHealthSeverity;
  label: string;
  title: string;
  showDot: boolean;
}

/**
 * `capture_reason` 만 `CaptureReason` 이 아니라 `string` 인 것은 의도다. 여기는 wire
 * 가 아니라 **투영 경계**라서, 서버가 프론트보다 앞서 나가 보낸 새 reason 이 정당하게
 * 들어온다 — 좁히면 그걸 타입 세탁해야 하고, 그러면 미지값 폴백이 테스트 불가가 된다.
 * 계약 강제는 wire 타입(`LiveStatus`)과 `CAPTURE_REASON_VIEW` 테이블이 이미 맡는다.
 */
export interface LiveStatusProjectionInput {
  status:
    | (Pick<LiveStatus, 'capture_healthy' | 'rest_capacity_scheduler'> & {
        capture_reason: string;
      })
    | null
    | undefined;
  inventory: InventoryState;
  tokenExpired?: boolean;
}

export interface LiveStatusProjection {
  banner: {
    primary: LiveBannerPrimary;
    stack: LiveBannerCause[];
  };
  captureHealth: CaptureHealthView;
}

const FALLBACK_CAPTURE_REASON = 'offline';

export function projectCaptureHealth(
  healthy: boolean,
  reason: string,
): CaptureHealthView {
  const severity = captureHealthSeverity(healthy, reason);
  return {
    severity,
    label: captureHealthLabel(healthy, reason),
    title: `capture_reason = ${reason}`,
    showDot: healthy && severity === 'ok',
  };
}

interface CaptureReasonView {
  label: string;
  severity: CaptureHealthSeverity;
}

/**
 * reason → (라벨, 등급)의 유일한 표. `CaptureReason` union 에 **exhaustive** 로 묶여
 * 있어서, 백엔드가 새 reason 을 추가하고 union 을 늘리면 여기가 컴파일 에러로 항목을
 * 요구한다. 이 결합이 없던 판에서 프론트 표에는 백엔드가 안 내는 값 4개가 한글로
 * 남고 실제로 나오는 `registration_incomplete` 만 빠져 있었다.
 *
 * `healthy` 항목은 두 함수의 `healthy` 불리언 단축 경로가 먼저 처리하므로 정상
 * 응답에선 쓰이지 않는다 — `capture_healthy=false` 인데 reason 만 `'healthy'` 인
 * 합성 입력(테스트)을 위해 남긴다.
 */
const CAPTURE_REASON_VIEW: Record<CaptureReason, CaptureReasonView> = {
  healthy: { label: 'LIVE●', severity: 'ok' },
  // 미기동·장 마감은 장애가 아니다 — 밤·주말 거짓-앰버를 막으려 ok 로 둔다.
  offline: { label: '오프라인', severity: 'ok' },
  closed: { label: '장 마감', severity: 'ok' },
  // WS 는 붙었는데 저장셋 REG ACK 가 덜 찼다. 30s 워치독이 같은 패스에서 재구독을
  // 시도하므로 한두 패스 떴다 사라지는 건 정상 과도기고, 지속되면 실제 전송 유실이다.
  registration_incomplete: { label: '구독 등록 미완', severity: 'error' },
};

/**
 * union 밖 문자열(서버가 프론트보다 앞서 나간 경우)은 **원문 그대로 + error** 로
 * 떨어뜨린다. 한글로 얼버무리지 않는 것이 의도다 — 낯선 영문 토큰이 빨간 pill 에
 * 뜨는 편이 계약 스큐를 훨씬 빨리 드러낸다.
 */
function captureReasonView(reason: string): CaptureReasonView {
  const table: Record<string, CaptureReasonView | undefined> = CAPTURE_REASON_VIEW;
  return table[reason] ?? { label: reason, severity: 'error' };
}

export function captureHealthSeverity(
  healthy: boolean,
  reason: string,
): CaptureHealthSeverity {
  if (healthy) return 'ok';
  return captureReasonView(reason).severity;
}

export function captureHealthLabel(healthy: boolean, reason: string): string {
  if (healthy) return 'LIVE●';
  return captureReasonView(reason).label;
}

export function projectLiveStatus({
  status,
  inventory,
  tokenExpired = false,
}: LiveStatusProjectionInput): LiveStatusProjection {
  const reason = status?.capture_reason ?? FALLBACK_CAPTURE_REASON;
  const captureHealth = projectCaptureHealth(status?.capture_healthy ?? false, reason);
  const stack: LiveBannerCause[] = tokenExpired ? ['kis_token_expired'] : [];
  // `status` 를 못 받은 경우까지 포함해 **모든 반환 경로가 같은 배열을 공유**하므로
  // 여기서 한 번만 넣는다. 죽은 앱키는 지금 서버를 직접 뒤져야만 보이고, 화면에는
  // "일부 과거구간 로딩 실패" 밖에 안 뜬다(#1088 계열의 조용한 실패).
  if (authFailingKiwoomKeys(status).length > 0) stack.push('kiwoom_auth_failing');

  if (!status) {
    return { banner: { primary: null, stack }, captureHealth };
  }

  if (inventory.kind === 'watchlist' && inventory.size !== null) {
    if (inventory.size === 0) {
      return { banner: { primary: 'watchlist_empty', stack }, captureHealth };
    }
    // ADR-0118 F2: 실시간=키움 전담. 시장 열림(offline)인데 세션이 없으면 호가·체결이
    // 조용히 멈추므로 배너로 표면화. closed(장 마감)는 정지가 정상이라 여기 안 걸린다.
    if (reason === 'offline') {
      return { banner: { primary: 'realtime_unavailable', stack }, captureHealth };
    }
    // 여기 있던 `credentials_missing` 분기는 **도달 불가라서** 내렸다. 조건이
    // `!running && started_at_ms == null && reason ∉ {offline, closed}` 였는데,
    // offline/closed 가 아닌 모든 reason(healthy·registration_incomplete)은
    // `connected_accounts > 0` 을 함의하고 그건 `running=true` 를 함의한다
    // (lifecycle.py::get_status) — 즉 `!running` 을 영영 만족하지 못한다.
    //
    // 원래 의도(캔들·지수 경로의 KIS 키 결측 표면화)는 이 자리에서 이미 실패하고
    // 있었다. 다시 필요하면 capture_reason 을 우회 추론하지 말고 백엔드가 그
    // 사실을 직접 실어 보내야 한다 — 그게 이 분기가 죽은 진짜 이유다.
  }

  return { banner: { primary: null, stack }, captureHealth };
}

export function useLiveStatusProjection(
  status: LiveStatus | undefined | null,
  opts?: { tokenExpired?: boolean },
): LiveStatusProjection {
  const { data: watchlist } = useWatchlist();
  const size = watchlist === undefined ? null : watchlist.entries.length;
  return projectLiveStatus({
    status,
    inventory: { kind: 'watchlist', size },
    tokenExpired: opts?.tokenExpired,
  });
}

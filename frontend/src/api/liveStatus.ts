import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

/**
 * 백엔드가 실제로 내보내는 `capture_reason` 값의 전수. 미러:
 * `hoga/live/lifecycle.py::LiveStatus.capture_reason` (같은 Literal).
 *
 * **`liveStatusProjection` 의 라벨·severity 테이블이 이 union 에 exhaustive 로
 * 묶여 있다** — 멤버를 늘리면 그쪽이 컴파일 에러로 lockstep 을 요구한다. 그 결합이
 * 이 타입의 존재 이유다: 예전엔 `string` 이라 백엔드가 값을 바꿔도 프론트가 조용히
 * 원문을 렌더했고, 그렇게 죽은 라벨 4개(`reconnecting`·`subscribing`·`sub_failed`·
 * `stale`)가 ADR-0118 PR-G 이후 1년 가까이 남아 있었다 — 정작 실제로 나오는
 * `registration_incomplete` 는 매핑이 없어 영문 원문으로 노출되면서.
 *
 * 다만 **런타임 보장은 아니다**. 서버가 앞서 나가면 union 밖 문자열이 실제로 도착할
 * 수 있어서, 투영 경계(`LiveStatusProjectionInput`)는 의도적으로 `string` 을 받고
 * 미지값 폴백을 유지한다.
 */
export type CaptureReason = 'healthy' | 'offline' | 'closed' | 'registration_incomplete';

export interface LiveStatus {
  running: boolean;
  started_at_ms: number | null;
  last_tick_ms: number | null;
  cycle_lag_ms: number;
  /** 캡처 헬스(spec 2026-06-08 §2.2). cycle_lag_ms(0 고정)를 대체하는 신호. */
  capture_healthy: boolean;
  capture_reason: CaptureReason;
  /**
   * Codes the live poller is *actively iterating* — a poller-health metric,
   * NOT the watchlist inventory size. It is 0 whenever the poller isn't
   * running (missing KIS creds, off-hours, never started). For "how many
   * symbols are on the watchlist", read GET /api/watchlist (`useWatchlist`).
   * Keying UI empty-states off this field conflates the two (diagnose 2026-05-30).
   */
  watchlist_count: number;
  /** Codes the backend is *actively collecting* in the current cycle. Used for collection-status badge visibility. */
  live_set: string[];
  rest_bypass_enabled: boolean;
  // 키움 WS 수집 관측(ADR-0116). 키움 미배선/무자격(앱키 없음)이면 null. 백엔드 신규
  // 필드라 optional — 설정 상태줄·커버리지 칩이 소비한다.
  kiwoom?: KiwoomStatus | null;
  // lifespan 소유 배경 태스크의 정직한 liveness(ADR-0088). 백엔드가 lifespan 밖
  // (테스트 등)이면 없을 수 있어 optional.
  supervised_tasks?: SupervisedTask[];
  // 데이터 디렉터리 파일시스템의 여유. 조회 실패·미주입이면 없음.
  disk?: DiskHeadroom | null;
  // 키움 REST 유량 거버너 관측. 거버너 미가동이면 없음.
  rest_capacity_scheduler?: KiwoomGovernorSnapshot | null;
}

/**
 * 키움 REST 유량 거버너 스냅샷. 미러: `hoga/live/lifecycle.py::KiwoomGovernorSnapshot`.
 *
 * 오래 `dict[str, object]` 로 나가면서 프론트에는 미러도 소비도 없었다 — ADR-0136 이
 * KIS 의 `kis_calls_today` 를 두고 지적한 "렌더 0곳인 죽은 필드" 와 같은 상태였다.
 */
export interface KiwoomGovernorSnapshot {
  queued: number;
  inflight: number;
  workers: number;
  tr_buckets: number;
  accounts: number;
  /** 계정별 **시도** 수(성공 전에 센다). 쏠림이 없으면 앱키 증설이 배수를 못 낸다. */
  calls_by_account: Record<string, number>;
  /** 인증 실패 **누계** — 리셋되지 않으므로 "지금 죽었나" 의 답이 아니다. */
  auth_failures_by_account: Record<string, number>;
  /** 지금 격리 창(60s) 안. **정상 만료도 여기 들어온다** — 경고 근거로 쓰지 말 것. */
  auth_blocked_accounts: number[];
  /** 연속 실패가 임계를 넘어 **앱키가 죽었다고 판정된** 계정. */
  auth_failing_accounts: number[];
  /**
   * 위 계정의 **env 변수명**. 화면은 이쪽을 보여 준다 — account 5 ↔
   * `KIWOOM_APP_KEY_6` 의 off-by-one 을 여기서 다시 계산하면 애먼 키를 지우게 된다.
   * 그래서 백엔드가 이름을 직접 실어 보낸다.
   */
  auth_failing_env_keys: string[];
  background_deferred_due_to_user_visible: number;
}

/**
 * 디스크 여유. 미러: hoga/api/prune.py::DiskHeadroom.
 *
 * `low` 는 백엔드 임계(10% 미만)다. raw 가 거래일당 ~33GB 씩 자라는데 능동 신호가
 * 하루 한 번 로그 한 줄뿐이라, 가득 차는 순간을 사용자들의 "데이터가 없어요" 로
 * 알게 되던 것을 막기 위한 표면이다(2026-08-03).
 */
export interface DiskHeadroom {
  free_pct: number;
  free_gib: number;
  low: boolean;
}

/**
 * 한 배경 태스크의 상태. 미러: hoga/api/startup_runtime.py::_task_health.
 *
 * `running` 불리언만으로는 "죽었다"와 "애초에 안 띄웠다(env 비활성·미주입)"를
 * 구별할 수 없어 경보에 쓸 수 없다 — `HOGA_LIVE_TODAY_PROMOTE_ENABLED=false` 면
 * today-promoter 는 정상인데도 영구히 `running:false` 다. **경보는 `state`가
 * `'dead'`인 항목만 봐야 한다.**
 *
 * `'completed'`는 one-shot(`watchlist-catchup`·`symbols-boot-refresh`)이 할 일을
 * 마치고 정상 반환한 상태다 — 경보 아님. 이 값이 없던 판에서는 부팅 캐치업이
 * 끝나는 순간 전 사용자에게 "백그라운드 작업이 중단됐습니다" 토스트가 상시 떴다.
 */
export interface SupervisedTask {
  name: string;
  running: boolean;
  state?: 'running' | 'dead' | 'completed' | 'not_started';
}

/**
 * 인증이 죽었다고 **판정된** 키움 앱키의 env 변수명들. 없으면 빈 배열.
 *
 * `auth_blocked_accounts` 를 쓰지 않는 이유: 정상 토큰 만료도 60초 격리를 남기므로
 * 멀쩡한 동작에 경고가 뜬다. 판정은 백엔드가 **연속** 실패로 한다
 * (`kiwoom_capacity._AUTH_FAILING_THRESHOLD`) — 임계값을 여기로 옮기지 말 것.
 */
export function authFailingKiwoomKeys(
  // 전체 `LiveStatus` 를 요구하지 않는다 — `projectLiveStatus` 가 테스트 편의를 위해
  // **의도적으로 좁힌** 입력을 받기 때문이다(그 타입에 전체를 강요하면 모든 테스트
  // 픽스처가 무관한 필드를 채워야 한다).
  status: { rest_capacity_scheduler?: KiwoomGovernorSnapshot | null } | undefined | null,
): string[] {
  return status?.rest_capacity_scheduler?.auth_failing_env_keys ?? [];
}

/** 조용히 죽은 배경 태스크 이름들. 미기동·정상완료는 죽음이 아니다. */
export function deadSupervisedTasks(status: LiveStatus | undefined): string[] {
  return (status?.supervised_tasks ?? [])
    .filter((t) => t.state === 'dead')
    .map((t) => t.name);
}

export interface KiwoomStatus {
  enabled: boolean;
  accounts_configured: number;
  connected_accounts: number;
  subscribed_count: number;
  // 키움 WS 수집 중인 종목 코드(화질 도트용). deriveCollectionStatus가 멤버십으로
  // realtime(●) 판정. 백엔드 신규 필드라 optional — 구 응답엔 없을 수 있음.
  subscribed_codes?: string[];
  last_tick_ms: number | null;
  // 저장셋 REG ACK 미확인 키가 남아 있는가(kiwoom_session.status() 미러). 이게 참이면
  // lifecycle 이 capture_reason='registration_incomplete' 로 승격한다 — 즉 pill 이
  // 이미 같은 사실을 말하므로 현재 소비처는 없다. optional 인 이유는 구 응답 호환.
  registration_incomplete?: boolean;
  accounts: KiwoomAccountStatus[];
}

export interface KiwoomAccountStatus {
  account_id: number;
  connected: boolean;
  sub_expected: number;
  sub_acked: number;
  kicked_by_peer: boolean;
  last_tick_ms: number | null;
}

/**
 * Polls `/api/live/status` every 5 seconds.
 *
 * The endpoint is cheap (in-memory state read) so 5s is generous; matches the
 * spec §10 LiveStatusBar cadence. Keep this as the wire-shaped fetch hook;
 * frontend UI meaning is projected in `liveStatusProjection`.
 */
export function useLiveStatus() {
  return useQuery({
    queryKey: ['live', 'status'],
    queryFn: () => apiCall<LiveStatus>('/api/live/status'),
    refetchInterval: 5_000,
    staleTime: 1_000,
  });
}

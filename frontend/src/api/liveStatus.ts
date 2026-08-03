import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export interface LiveStatus {
  running: boolean;
  started_at_ms: number | null;
  last_tick_ms: number | null;
  cycle_lag_ms: number;
  /** 캡처 헬스(spec 2026-06-08 §2.2). cycle_lag_ms(0 고정)를 대체하는 신호. */
  capture_healthy: boolean;
  capture_reason: string;
  /**
   * Codes the live poller is *actively iterating* — a poller-health metric,
   * NOT the watchlist inventory size. It is 0 whenever the poller isn't
   * running (missing KIS creds, off-hours, never started). For "how many
   * symbols are on the watchlist", read GET /api/watchlist (`useWatchlist`).
   * Keying UI empty-states off this field conflates the two (diagnose 2026-05-30).
   */
  watchlist_count: number;
  kis_calls_today: number;
  kis_rate_limit_remaining: number | null;
  /** Codes the backend is *actively collecting* in the current cycle. Used for collection-status badge visibility. */
  live_set: string[];
  kis_rest_bypass_enabled: boolean;
  // 키움 WS 수집 관측(ADR-0116). 키움 미배선/무자격(앱키 없음)이면 null. 백엔드 신규
  // 필드라 optional — 설정 상태줄·커버리지 칩이 소비한다.
  kiwoom?: KiwoomStatus | null;
  // lifespan 소유 배경 태스크의 정직한 liveness(ADR-0088). 백엔드가 lifespan 밖
  // (테스트 등)이면 없을 수 있어 optional.
  supervised_tasks?: SupervisedTask[];
  // 데이터 디렉터리 파일시스템의 여유. 조회 실패·미주입이면 없음.
  disk?: DiskHeadroom | null;
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

import type { LiveStatus } from '../api/liveStatus';
import { useWatchlist } from '../watchlist/useWatchlist';

export type LiveBannerCause =
  | 'watchlist_empty'
  | 'kis_credentials_missing'
  | 'kis_token_expired'
  | 'realtime_unavailable';

export type InventoryState =
  | { kind: 'watchlist'; size: number | null }
  | { kind: 'heatmap'; size: number | null }
  | { kind: 'unknown' };

export type CaptureHealthSeverity = 'ok' | 'warn' | 'error';

export interface CaptureHealthView {
  severity: CaptureHealthSeverity;
  label: string;
  title: string;
  showDot: boolean;
}

export interface LiveStatusProjectionInput {
  status: Pick<LiveStatus, 'running' | 'started_at_ms' | 'cycle_lag_ms' | 'capture_healthy' | 'capture_reason' | 'watchlist_count'> | null | undefined;
  inventory: InventoryState;
  tokenExpired?: boolean;
}

export interface LiveStatusProjection {
  banner: {
    primary: 'watchlist_empty' | 'kis_credentials_missing' | 'realtime_unavailable' | null;
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

export function captureHealthSeverity(
  healthy: boolean,
  reason: string,
): CaptureHealthSeverity {
  if (healthy) return 'ok';
  if (reason === 'offline' || reason === 'closed') return 'ok';
  if (reason === 'reconnecting' || reason === 'subscribing') return 'warn';
  return 'error';
}

export function captureHealthLabel(healthy: boolean, reason: string): string {
  if (healthy) return 'LIVE●';
  switch (reason) {
    case 'offline': return '오프라인';
    case 'closed': return '장 마감';
    case 'reconnecting': return '재연결 중...';
    case 'subscribing': return '구독 중...';
    case 'sub_failed': return '구독 실패';
    case 'stale': return '수신 끊김';
    default: return reason;
  }
}

export function projectLiveStatus({
  status,
  inventory,
  tokenExpired = false,
}: LiveStatusProjectionInput): LiveStatusProjection {
  const reason = status?.capture_reason ?? FALLBACK_CAPTURE_REASON;
  const captureHealth = projectCaptureHealth(status?.capture_healthy ?? false, reason);
  const stack: LiveBannerCause[] = tokenExpired ? ['kis_token_expired'] : [];

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
    // 정지+미시작이면서 offline/closed가 아닌 잔여 상태 = KIS 자격증명 문제로 간주
    // (캔들·지수 경로의 KIS 키 결측). closed는 실시간 정지가 정상이므로 제외.
    if (!status.running && status.started_at_ms == null && reason !== 'closed') {
      return { banner: { primary: 'kis_credentials_missing', stack }, captureHealth };
    }
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

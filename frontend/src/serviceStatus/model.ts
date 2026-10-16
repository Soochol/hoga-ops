import { authFailingKiwoomKeys, type CollectorStateReason, type LiveStatus, type ProviderStatus } from '../api/liveStatus';

export type ServiceIssue = {
  id: string;
  source: 'provider' | 'disk' | 'task' | 'collector' | 'capture' | 'auth';
  kind?: NonNullable<ProviderStatus['failures']>[number]['kind'];
  collectorDetails?: string;
  title: string;
  cause: string;
  action: string;
  at?: number;
  operation?: string;
  code?: string | null;
  channel?: 'ws' | 'rest';
  accountId?: number | null;
  phase?: string | null;
  connectionGeneration?: number | null;
  elapsedMs?: number | null;
  tone: 'warn' | 'error';
};
export type ClearedIssue = ServiceIssue & { clearedAt: number };
export const CONNECTION_COPY: Record<ProviderStatus['connection'], string> = {
  paused: '운영시간 외 대기', unconfigured: '미설정', connecting: '연결 확인 중',
  unavailable: '연결 불가', partial: '일부 연결·구독 미완료 또는 수신 지연', connected: '실시간 연결 정상',
};
const COLLECTOR_COPY: Record<CollectorStateReason, string> = {
  ready: '수집 준비가 완료되었습니다.', syncing: '실시간 설정을 반영하고 있습니다.',
  stopping: '수집 프로세스가 종료 중입니다.', dead: '수집 프로세스가 중단되었습니다.',
  ipc_closed: '수집 프로세스와의 통신이 끊겼습니다.', state_stale: '최근 수집 상태 보고가 만료되었습니다.',
  sync_failed: '실시간 설정 반영에 실패했거나 대기 시간을 초과했습니다.',
  storage_error: '필수 실시간 데이터를 저장하지 못했습니다.',
};
const FAILURE_COPY = {
  auth: ['인증 실패', '앱키·접근 권한을 확인하세요.'],
  rate_limit: ['호출 한도 초과', '잠시 후 다시 조회하세요.'],
  timeout: ['응답 시간 초과', '잠시 후 다시 조회하세요.'],
  transport: ['연결 실패', '네트워크 또는 서버 상태를 확인하세요.'],
  server: ['서버 오류', '잠시 후 다시 조회하세요.'],
  request: ['요청 거절', '요청 조건을 확인해야 합니다.'],
  unknown: ['원인 미확인', '마지막 요청이 실패했습니다. 상세 코드를 확인하세요.'],
} as const;
const OPERATIONS: Record<string, string> = { ka90013: '프로그램매매', ka10001: '종목정보' };
export function failurePhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    token: '토큰 발급', connect: '연결 시작', LOGIN: '로그인', REG: '구독 등록',
    REMOVE: '구독 해제', receive: '프레임 수신', dispatch: '데이터 처리', close: '연결 종료',
  };
  return labels[phase] ?? phase;
}

export function serviceIssues(status: LiveStatus | undefined): ServiceIssue[] {
  const provider = status?.provider_status;
  const collector = status?.kiwoom?.collector;
  const issues: ServiceIssue[] = (provider?.failures ?? []).map((failure) => {
    const [cause, action] = FAILURE_COPY[failure.kind];
    const dataFailure = failure.channel === 'ws' && failure.phase === 'dispatch';
    return {
      id: `provider:${failure.channel}:${failure.operation}:${failure.kind}` +
        (failure.account_id != null ? `:account:${failure.account_id}` : '') +
        (failure.phase ? `:phase:${failure.phase}` : ''),
      source: 'provider', kind: failure.kind, title: failure.channel === 'ws' ? '키움 실시간 연결 실패'
        : `${OPERATIONS[failure.operation] ?? failure.operation} 조회 실패`,
      cause: failure.code === '1504' ? 'API 요청 경로가 올바르지 않습니다.'
        : dataFailure ? '서버 내부 실시간 데이터 처리 지연 또는 실패' : cause,
      action: failure.code === '1504' ? '앱 수정이 필요합니다.'
        : dataFailure ? '서버의 처리 지연과 자동 재연결 상태를 확인하세요.'
        : failure.channel === 'ws' && failure.kind === 'timeout'
          ? '자동 재연결 상태와 구독 준비 상태를 확인하세요.' : action,
      at: failure.observed_at_ms, operation: failure.operation, code: failure.code,
      channel: failure.channel, accountId: failure.account_id, phase: failure.phase,
      connectionGeneration: failure.connection_generation, elapsedMs: failure.elapsed_ms,
      tone: failure.kind === 'auth' || failure.kind === 'request' ? 'error' : 'warn',
    };
  });
  if (provider && !(collector?.state_reason === 'syncing'
      && provider.connected_accounts === provider.configured_accounts) && (provider.connection === 'unavailable' || provider.connection === 'partial') &&
      !issues.some((issue) => issue.id.startsWith('provider:ws:'))) {
    issues.push({ id: 'provider:connection', source: 'provider', title: `키움 ${CONNECTION_COPY[provider.connection]}`,
      cause: `연결 ${provider.connected_accounts}/${provider.configured_accounts}계정`,
      action: '실시간 데이터 수신 상태를 확인하세요.', at: provider.observed_at_ms, tone: 'warn' });
  }
  if (collector && !collector.ready && collector.state_reason !== 'syncing') {
    issues.push({ id: 'collector', source: 'collector', title: collector.storage_errors.length
      ? '실시간 데이터 저장 오류' : '실시간 수집 상태 확인 불가',
      cause: collector.storage_errors.length ? COLLECTOR_COPY.storage_error
        : collector.state_reason ? COLLECTOR_COPY[collector.state_reason] : '수집 준비 상태를 확인할 수 없습니다.',
      action: '자동 복구 상태와 서버 기록을 확인하세요.', tone: 'error',
      collectorDetails: `수집 사유: ${collector.state_reason ?? '정보 없음'} · 저장 오류: ${collector.storage_errors.join(', ') || '없음'}\n수집 PID: ${collector.pid} · epoch: ${collector.epoch}\n설정 버전: ${collector.desired_version} · ACK: ${collector.acked_version} · 상태 버전: ${collector.state_version ?? '정보 없음'}\n상태 나이: ${collector.state_age_ms ?? '정보 없음'}ms · 동기화 단계: ${collector.sync_phase ?? '없음'} · 경과: ${collector.sync_age_ms ?? '없음'}ms`,
    });
  }
  // Preserve legacy observations when replacing the page banner, without
  // duplicating the equivalent modern provider/collector issue.
  const authKeys = authFailingKiwoomKeys(status);
  if (authKeys.length) {
    const auth = issues.find(issue => issue.source === 'provider' && issue.kind === 'auth' && issue.channel === 'rest');
    if (auth) auth.cause += ` · ${authKeys.join(', ')}`;
    else issues.push({ id: 'kiwoom:auth', source: 'auth', title: '키움 앱키 인증 실패 — 과거 데이터 조회가 막힙니다',
      cause: authKeys.join(', '), action: '표시된 앱키의 인증 설정을 확인하세요.', tone: 'error' });
  }
  const reason = status?.capture_reason;
  if ((reason === 'collector_unavailable' || reason === 'storage_error') && !issues.some(issue => issue.id === 'collector')) {
    issues.push({ id: 'collector', source: 'capture', title: reason === 'storage_error' ? '실시간 데이터 저장 오류' : '실시간 수집 상태를 확인할 수 없습니다',
      cause: reason === 'storage_error' ? COLLECTOR_COPY.storage_error : '자동 복구를 기다리는 중입니다.',
      action: '서비스 상태와 서버 기록을 확인하세요.', tone: 'error' });
  }
  if (reason === 'offline' && (status?.watchlist_count ?? 0) > 0 && !issues.some(issue => issue.channel === 'ws' || issue.id === 'provider:connection' || issue.id === 'collector')) {
    issues.push({ id: 'provider:connection', source: 'capture', title: '실시간 미가동 — 호가·체결 스트림이 연결되지 않았습니다',
      cause: '관심종목이 있지만 실시간 수집이 가동되지 않았습니다.', action: '실시간 수집 설정을 확인하세요.', tone: 'warn' });
  }
  if (provider?.notice_config_error) issues.push({ id: 'provider:notice-config', source: 'provider',
    title: '키움 점검 공지 설정 확인 필요', cause: '공지 설정을 읽지 못했습니다.', action: '서버의 공지 설정을 확인하세요.', tone: 'warn' });
  if (status?.disk?.low) issues.push({ id: 'disk', source: 'disk', title: status.disk.free_pct < 5 ? '디스크가 거의 찼습니다' : '디스크 여유 부족',
    cause: `남은 공간 ${status.disk.free_pct}% · ${status.disk.free_gib} GiB`,
    action: '공간이 부족해지면 데이터 기록이 중단될 수 있습니다. 저장 공간을 확보하세요.', tone: status.disk.free_pct < 5 ? 'error' : 'warn' });
  for (const task of status?.supervised_tasks ?? []) {
    if (task.state === 'dead') issues.push({ id: `task:${task.name}`, source: 'task', title: '백그라운드 작업 중단',
      cause: task.name, action: '자동 복구되지 않는 작업입니다. 서버 상태를 확인하세요.', tone: 'error' });
  }
  return issues;
}

/** Absence is only meaningful when the corresponding observation is present. */
export function clearedIssues(previous: ServiceIssue[], next: ServiceIssue[], status: LiveStatus, at: number): ClearedIssue[] {
  return previous.filter((issue) => {
    const known = issue.source === 'provider' ? status.provider_status?.failures !== undefined
      && ((issue.channel !== 'ws' && issue.id !== 'provider:connection') || status.kiwoom?.collector?.ready !== false)
      : issue.source === 'collector' ? status.kiwoom?.collector?.ready === true
      : issue.source === 'capture' ? typeof status.capture_reason === 'string'
      : issue.source === 'auth' ? status.rest_capacity_scheduler != null
      : issue.source === 'disk' ? status.disk != null : status.supervised_tasks !== undefined;
    return known && !next.some((current) => current.id === issue.id);
  }).map((issue) => ({ ...issue, clearedAt: at }));
}

export function issueReport(issue: ServiceIssue): string {
  return [issue.title, issue.cause, issue.action, issue.operation && `API: ${issue.operation}`,
    issue.accountId != null && `계정: ${issue.accountId + 1}`,
    issue.phase && `실패 단계: ${failurePhaseLabel(issue.phase)}`,
    issue.connectionGeneration != null && `연결 세대: ${issue.connectionGeneration}`,
    issue.elapsedMs != null && `단계 소요: ${issue.elapsedMs.toFixed(1)}ms`,
    issue.collectorDetails,
    issue.code && `오류 코드: ${issue.code}`, issue.at && `마지막 실패: ${new Date(issue.at).toISOString()}`].filter(Boolean).join('\n');
}

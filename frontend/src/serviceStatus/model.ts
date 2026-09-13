import type { LiveStatus, ProviderStatus } from '../api/liveStatus';

export type ServiceIssue = {
  id: string;
  source: 'provider' | 'disk' | 'task';
  title: string;
  cause: string;
  action: string;
  at?: number;
  operation?: string;
  code?: string | null;
  tone: 'warn' | 'error';
};
export type ClearedIssue = ServiceIssue & { clearedAt: number };
export const CONNECTION_COPY: Record<ProviderStatus['connection'], string> = {
  paused: '운영시간 외 대기', unconfigured: '미설정', connecting: '연결 확인 중',
  unavailable: '연결 불가', partial: '일부 연결 또는 응답 지연', connected: '실시간 연결 정상',
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

export function serviceIssues(status: LiveStatus | undefined): ServiceIssue[] {
  const provider = status?.provider_status;
  const issues: ServiceIssue[] = (provider?.failures ?? []).map((failure) => {
    const [cause, action] = FAILURE_COPY[failure.kind];
    return {
      id: `provider:${failure.channel}:${failure.operation}:${failure.kind}`,
      source: 'provider', title: failure.channel === 'ws' ? '키움 실시간 연결 실패'
        : `${OPERATIONS[failure.operation] ?? failure.operation} 조회 실패`,
      cause: failure.code === '1504' ? 'API 요청 경로가 올바르지 않습니다.' : cause,
      action: failure.code === '1504' ? '앱 수정이 필요합니다.' : action,
      at: failure.observed_at_ms, operation: failure.operation, code: failure.code,
      tone: failure.kind === 'auth' || failure.kind === 'request' ? 'error' : 'warn',
    };
  });
  if (provider && (provider.connection === 'unavailable' || provider.connection === 'partial') &&
      !issues.some((issue) => issue.id.startsWith('provider:ws:'))) {
    issues.push({ id: 'provider:connection', source: 'provider', title: `키움 ${CONNECTION_COPY[provider.connection]}`,
      cause: `연결 ${provider.connected_accounts}/${provider.configured_accounts}계정`,
      action: '실시간 데이터 수신 상태를 확인하세요.', at: provider.observed_at_ms, tone: 'warn' });
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
      : issue.source === 'disk' ? status.disk != null : status.supervised_tasks !== undefined;
    return known && !next.some((current) => current.id === issue.id);
  }).map((issue) => ({ ...issue, clearedAt: at }));
}

export function issueReport(issue: ServiceIssue): string {
  return [issue.title, issue.cause, issue.action, issue.operation && `API: ${issue.operation}`,
    issue.code && `오류 코드: ${issue.code}`, issue.at && `마지막 실패: ${new Date(issue.at).toISOString()}`].filter(Boolean).join('\n');
}

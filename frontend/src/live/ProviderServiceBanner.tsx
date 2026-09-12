import { useLiveStatus, type ProviderStatus } from '../api/liveStatus';

function stamp(ms: number) {
  return new Date(ms).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
const FAILURE_COPY = {
  auth: '인증 실패 · 앱키·접근 권한을 확인하세요',
  rate_limit: '호출 제한 · 잠시 후 다시 시도하세요',
  timeout: '응답 시간 초과 · 최근 요청 실패',
  transport: '연결 실패 · 네트워크 또는 서버 상태를 확인하세요',
  server: '서버 오류 · 최근 요청 실패',
  request: '요청 거절 · 요청 조건을 확인해야 합니다',
  unknown: '원인 미확인 오류 · 연결/응답 오류가 발생했습니다',
};
const CONNECTION = {
  unconfigured: '키움 미설정', connecting: '키움 연결 확인 중',
  unavailable: '키움 연결 불가', partial: '키움 일부 연결 또는 응답 지연',
  connected: '키움 실시간 연결 정상',
};

export function ProviderServiceNotice({ status, error }: { status?: ProviderStatus | null; error: boolean }) {
  if (!status && !error) return null;
  if (!error && status && !status.notice && !status.notice_config_error && !status.failures?.length &&
      (status.connection === 'connected' || status.connection === 'unconfigured')) return null;
  const notice = status?.notice;
  const phase = status?.notice_phase;
  return <section role="status" aria-label="키움 서비스 상태"
    className="border-b border-warn bg-bg-card px-md py-2 text-xs text-fg">
    <div className="flex flex-wrap items-baseline gap-x-sm gap-y-1">
      <strong className="text-warn">{notice
        ? phase === 'scheduled' ? '키움 점검 예정' : phase === 'active' ? '키움 점검 시간' : '키움 점검 종료 예정 시각 경과'
        : error ? '키움 연결 상태 확인 불가' : status?.notice_config_error ? '키움 점검 공지 설정 확인 필요' : status?.failures?.length ? '키움 오류 감지' : CONNECTION[status!.connection]}</strong>
      {notice && <span>{stamp(notice.starts_at_ms)}–{stamp(notice.ends_at_ms)} KST 예정 · 종료 시간 변경 가능</span>}
      {notice && <span>{notice.reason}</span>}
    </div>
    <div className="mt-1 text-fg-dim">
      {error ? '상태 서버 연결 실패 · 이전 정보이며 복구 여부를 확인할 수 없습니다.'
        : status && `${CONNECTION[status.connection]} · 연결 ${status.connected_accounts}/${status.configured_accounts}계정`}
      {status?.last_received_at_ms != null && ` · 마지막 실시간 응답 ${stamp(status.last_received_at_ms)}`}
      {status && status.connection !== 'connected' && status.connection !== 'unconfigured' && ' · 표시 중인 값은 저장 데이터일 수 있습니다.'}
      {phase === 'overdue' && ' · 실제 실시간 연결 복구 확인 중'}
    </div>
    {!error && !!status?.failures?.length && <details className="mt-1 text-fg-dim">
      <summary className="cursor-pointer">
        {status.failures[0].channel === 'ws' ? '실시간 연결' : 'API 조회'} · {FAILURE_COPY[status.failures[0].kind]}
        {status.failures.length > 1 && ` · 총 ${status.failures.length}종류`} · 오류 상세
      </summary>
      <ul className="mt-1 space-y-1">
        {status.failures.map((failure) => <li key={`${failure.channel}-${failure.operation}-${failure.kind}`}>
          {failure.channel === 'ws' ? '실시간 연결' : 'API 조회'} · {FAILURE_COPY[failure.kind]}
          {' · '}{failure.operation}{failure.code ? ` (${failure.code})` : ''}
          {' · 마지막 실패 '}{stamp(failure.observed_at_ms)} · 해당 요청 성공 시 해제
        </li>)}
      </ul>
    </details>}
    {notice && <details className="mt-1 text-fg-dim"><summary className="cursor-pointer">공지 출처·영향 범위</summary>
      <p>{notice.source}</p><p>입출금 등 전자금융거래, 계좌개설·비대면 업무 및 미수금·추가증거금 확인 중단 안내. REST 조회와 다른 공급사의 상태는 이 연결 표시로 판정하지 않습니다.</p>
    </details>}
  </section>;
}

export function ProviderServiceBanner() {
  const { data, isError } = useLiveStatus();
  return <ProviderServiceNotice status={data?.provider_status} error={isError} />;
}

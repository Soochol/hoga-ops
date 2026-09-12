import { useLiveStatus, type ProviderStatus } from '../api/liveStatus';

function stamp(ms: number) {
  return new Date(ms).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
const CONNECTION = {
  unconfigured: '키움 미설정', connecting: '키움 연결 확인 중',
  unavailable: '키움 연결 불가', partial: '키움 일부 연결 또는 응답 지연',
  connected: '키움 실시간 연결 정상',
};

export function ProviderServiceNotice({ status, error }: { status?: ProviderStatus | null; error: boolean }) {
  if (!status && !error) return null;
  if (!error && status && !status.notice && !status.notice_config_error &&
      (status.connection === 'connected' || status.connection === 'unconfigured')) return null;
  const notice = status?.notice;
  const phase = status?.notice_phase;
  return <section role="status" aria-label="키움 서비스 상태"
    className="border-b border-warn bg-bg-card px-md py-2 text-xs text-fg">
    <div className="flex flex-wrap items-baseline gap-x-sm gap-y-1">
      <strong className="text-warn">{notice
        ? phase === 'scheduled' ? '키움 점검 예정' : phase === 'active' ? '키움 점검 시간' : '키움 점검 종료 예정 시각 경과'
        : error ? '키움 연결 상태 확인 불가' : status?.notice_config_error ? '키움 점검 공지 설정 확인 필요' : CONNECTION[status!.connection]}</strong>
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
    {notice && <details className="mt-1 text-fg-dim"><summary className="cursor-pointer">공지 출처·영향 범위</summary>
      <p>{notice.source}</p><p>입출금 등 전자금융거래, 계좌개설·비대면 업무 및 미수금·추가증거금 확인 중단 안내. REST 조회와 다른 공급사의 상태는 이 연결 표시로 판정하지 않습니다.</p>
    </details>}
  </section>;
}

export function ProviderServiceBanner() {
  const { data, isError } = useLiveStatus();
  return <ProviderServiceNotice status={data?.provider_status} error={isError} />;
}

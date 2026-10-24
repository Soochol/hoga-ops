import type { ScreenerUpdating, ScreenerDailyIngestStatus } from '../api/screener';

/** 갱신 job 진행 칩 + 바. status.updating(서버 진실)만 그린다 — WS 이벤트는
 *  useScreenerUpdateSync 가 같은 캐시 필드로 흘려보내므로 여기서는 구독이 없다. */
export function ScreenerUpdateProgress({ updating, daily }: {
  updating: ScreenerUpdating | null | undefined;
  daily?: ScreenerDailyIngestStatus | null;
}) {
  if (!updating) {
    if (!daily?.checked_on) return null;
    return <span className="font-data text-xs tabular-nums text-fg-dim" role="status">
      일봉 재대조 {daily.checked_on} · 확정 {daily.confirmed.toLocaleString()}건
      {` · 잠정 ${daily.provisional.toLocaleString()}건 · 충돌 격리 ${daily.quarantined.toLocaleString()}건`}
      {daily.failed_codes > 0 ? ` · 확인 실패 ${daily.failed_codes.toLocaleString()}종목` : null}
      {daily.unavailable_codes > 0 ? ` · 공급자 미제공 ${daily.unavailable_codes.toLocaleString()}종목` : null}
      {daily.excluded_dates > 0 ? ` · 수집 대상 외 ${daily.excluded_dates.toLocaleString()}일봉` : null}
      {daily.retired_codes > 0 ? ` · 종료 확인 ${daily.retired_codes.toLocaleString()}종목 · 미제공 재시도 ${daily.retryable_unavailable_codes.toLocaleString()}종목` : null}
      {daily.commit_pending ? ' · 저장 재시도 대기' : null}
    </span>;
  }
  // **wire 값을 그대로 믿지 않는다.** 백엔드 재시도 패스가 같은 종목을 다시 세면
  // `done` 이 `total` 을 넘을 수 있다 — #1720 이 백엔드에서 클램프했지만 그 방어는
  // 저쪽에만 있어서, 여기 없으면 미래의 카운터 변경이 곧장 "갱신 중 4,400/4,335" 로
  // 새어 나온다. 표시 숫자와 바를 **같은 값**으로 묶어 둘이 어긋나지 않게 한다.
  const done = Math.min(Math.max(updating.done, 0), Math.max(updating.total, 0));
  const pct = updating.total > 0 ? Math.round((done / updating.total) * 100) : 0;
  return (
    <span
      data-testid="screener-update-progress"
      className="inline-flex items-center gap-1.5 font-data text-xs tabular-nums text-fg-dim"
      data-tooltip={updating.phase ? "과거 데이터 복구 진행 상황입니다" : "최근 일봉을 수신해 잠정·확정·충돌 상태를 확인합니다"}
    >
      {updating.phase ?? '갱신 중'}
      {(updating.total > 0 || !updating.phase) && ` ${done.toLocaleString()}/${updating.total.toLocaleString()}`}
      <span className="relative h-1 w-24 rounded-sm bg-bg-input" aria-hidden>
        <span
          style={{ width: `${pct}%` }}
          className="absolute bottom-0 left-0 top-0 rounded-sm bg-accent"
        />
      </span>
    </span>
  );
}

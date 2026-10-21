import type { BarVolumeCoverage as Coverage } from '../api/screener';

export function BarVolumeCoverage({ coverage }: { coverage?: Coverage | null }) {
  if (!coverage?.realtime) return null;
  return <div className="text-xs text-fg-dim" role="status">
    {coverage.realtime && <div>
      {coverage.realtime.continuous ? <>
        실시간 감시 {coverage.realtime.receiving}/{coverage.total}종목
        {!!coverage.realtime.preparing && ` · 준비 중 ${coverage.realtime.preparing}`}
        {!!coverage.realtime.recovering && ` · 복구 중 ${coverage.realtime.recovering}`}
        {!!coverage.realtime.monitor_error && ` · ${coverage.realtime.monitor_error}`}
        {!!coverage.realtime.unavailable && ` · 연결 확인 필요 ${coverage.realtime.unavailable}`}
      </> : <>
        장중 체결 반영 {coverage.realtime.receiving}/{coverage.total}종목
        {coverage.realtime.receiving < coverage.total && ' · 나머지는 분봉 재조회'}
      </>}
    </div>}
  </div>;
}

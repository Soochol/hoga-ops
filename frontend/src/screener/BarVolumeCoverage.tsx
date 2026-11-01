import type { BarVolumeCoverage as Coverage } from '../api/screener';
import { coverageReasonText } from './coverageReasonText';

export function BarVolumeCoverage({ coverage, hideSummary = false }: { coverage?: Coverage | null; hideSummary?: boolean }) {
  if (!coverage) return null;
  const counts = new Map<string, Set<string>>();
  for (const item of coverage.incomplete) {
    const label = coverageReasonText(item.reason);
    const codes = counts.get(label) ?? new Set<string>();
    codes.add(item.code); counts.set(label, codes);
  }
  return <div className="text-xs text-fg-dim" role="status">
    {!hideSummary && (coverage.incomplete.length > 0 || coverage.trading_date) && <div>
      {coverage.trading_date ? `${coverage.trading_date} 분봉 · 판정 ${coverage.complete.toLocaleString()}/${coverage.total.toLocaleString()}종목`
        : `대상 ${coverage.total}종목 · 전체 조건 평가 가능 ${coverage.complete}종목 · 확인 필요 ${coverage.total - coverage.complete}종목`}
    </div>}
    {counts.size > 0 && <details>
      <summary>상세 사유 · {coverage.total - coverage.complete}종목 확인 대기·보류</summary>
      {[...counts].map(([label, codes]) => <div key={label}>{label}: {codes.size}종목</div>)}
    </details>}
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

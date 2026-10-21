import type { BarVolumeCoverage as Coverage } from '../api/screener';

const REASONS: Record<string, string> = {
  adjustment_unavailable: '분봉 수정계수 미확인 · 가격 비교 불가',
  missing_reference: '기준이 되는 전일 종가 미확인',
  missing_history: '비교할 봉 이력 부족 · 원인 미확인',
  insufficient_history: '비교할 봉 수 부족',
  volume_preparing: '비교할 분봉 준비 중',
  insufficient_minute_history: '비교할 분봉 수 부족',
  live_bar_unconfirmed: '체결 수신 공백 · 분봉 재조회로 확인 필요',
  calendar_unavailable: '거래일 달력 범위 부족',
  pre_listing_history: '상장 전 구간 포함 · 비교할 봉 수 부족',
  delisted: '상장폐지 이후 구간 · 일봉 없음',
  trading_suspended: '확인된 거래정지 기간 · 일봉 없음',
  collection_missing: '공급자에 있는 일봉의 수집 누락 · 보충 필요',
  vendor_history_unavailable: '공급자 응답에도 일봉 없음 · 거래 상태 또는 제공 범위 확인 필요',
  missing_daily_history: '일봉 이력 누락 · 상장·거래 상태 또는 수집 여부 미확인',
  invalid_daily_rows: '일봉 가격 데이터 확인 필요',
  credentials_missing: '키움 API 연결 설정 필요',
  rest_bypassed: '시세 조회 중지됨',
  invalid_rows: '분봉 데이터 확인 필요',
  fetch_budget_exhausted: '조회 범위 초과 · 기간 또는 종목 범위를 좁혀 주세요',
  fetch_timeout: '분봉 조회 지연 · 다시 조회하세요',
};

export function BarVolumeCoverage({ coverage }: { coverage?: Coverage | null }) {
  if (!coverage) return null;
  const reasons = [...new Set(coverage.incomplete.map(item => item.reason))];
  const incompleteCount = new Set(coverage.incomplete.map(item => item.code)).size;
  if (incompleteCount === 0 && !coverage.realtime) return null;
  return <div className="text-xs text-fg-dim" role="status">
    {coverage.realtime && <div>
      {coverage.realtime.continuous ? <>
        실시간 감시 {coverage.realtime.receiving}/{coverage.total}종목
        {!!coverage.realtime.preparing && ` · 준비 중 ${coverage.realtime.preparing}`}
        {!!coverage.realtime.recovering && ` · 복구 중 ${coverage.realtime.recovering}`}
        {!!coverage.realtime.insufficient && ` · 이력 부족 ${coverage.realtime.insufficient}`}
        {!!coverage.realtime.monitor_error && ` · ${coverage.realtime.monitor_error}`}
        {!!coverage.realtime.unavailable && ` · 연결 확인 필요 ${coverage.realtime.unavailable}`}
      </> : <>
        장중 체결 반영 {coverage.realtime.receiving}/{coverage.total}종목
        {coverage.realtime.receiving < coverage.total && ' · 나머지는 분봉 재조회'}
      </>}
    </div>}
    {incompleteCount > 0 && <details>
      <summary>이력 부족 {incompleteCount}종목</summary>
      <ul>{reasons.map(reason => {
        const items = coverage.incomplete.filter(item => item.reason === reason);
        const count = new Set(items.map(item => item.code)).size;
        return <li key={reason}><details>
          <summary>{REASONS[reason] ?? reason} · {count}종목</summary>
          <ul>{items.map((item, index) => <li key={`${item.code}:${item.condition_id}:${index}`}>
            {item.name ? `${item.name} (${item.code})` : item.code}
            {item.missing_days != null && ` · ${item.missing_days}거래일`}
            {item.required_from && item.required_to && ` · ${item.required_from}~${item.required_to}`}
          </li>)}</ul>
        </details></li>;
      })}</ul>
    </details>}
  </div>;
}

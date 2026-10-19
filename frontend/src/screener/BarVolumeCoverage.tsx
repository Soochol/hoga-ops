import type { BarVolumeCoverage as Coverage } from '../api/screener';

const REASONS: Record<string, string> = {
  adjustment_unavailable: '분봉 수정계수 미확인 · 가격 비교 불가',
  missing_history: '비교 이력 또는 거래일 달력 부족',
  credentials_missing: '키움 API 연결 설정 필요',
  rest_bypassed: '시세 조회 중지됨',
  invalid_rows: '분봉 데이터 확인 필요',
  fetch_budget_exhausted: '조회 범위 초과 · 기간 또는 종목 범위를 좁혀 주세요',
  fetch_timeout: '분봉 조회 지연 · 다시 조회하세요',
};

export function BarVolumeCoverage({ coverage }: { coverage?: Coverage | null }) {
  if (!coverage) return null;
  const reasons = [...new Set(coverage.incomplete.map(item => item.reason))];
  return <div className="text-xs text-fg-dim" role="status">
    봉수 기준 평가 가능 {coverage.complete}/{coverage.total}종목
    {reasons.length > 0 && <details>
      <summary>일부 이력 미확인 · 확인된 발생 건만 표시</summary>
      <ul>{reasons.map(reason => <li key={reason}>{REASONS[reason] ?? reason}</li>)}</ul>
    </details>}
  </div>;
}

import type { ScreenerRun } from '../api/screenerRuns';

export function ScreenerPreparationStatus({ run }: { run?: ScreenerRun | null }) {
  if (!run) return null;
  if (run.minute_date) return <div role="status" aria-label="분봉 검색 진행" className="text-xs text-fg-dim">
    {run.minute_date} 분봉 {run.status === 'queued' || run.status === 'preparing' ? '검색 중' : '검색 종료'}
    {` · 처리 ${(run.total - run.preparing).toLocaleString()}/${run.total.toLocaleString()}종목`}
    {` · 판정 ${run.evaluated.toLocaleString()}종목 · 일치 ${run.result?.has_more ? '최소 ' : ''}${(run.result?.rows.length ?? 0).toLocaleString()}종목`}
    {run.waiting > 0 && ` · 판정 보류 ${run.waiting.toLocaleString()}종목`}
    {run.failed > 0 && ` · 확인 실패 ${run.failed.toLocaleString()}종목`}
    {Object.keys(run.errors).length > 0 && <details><summary>상세 사유</summary>
      {Object.entries(run.errors).map(([code, reason]) => <div key={code}>{code}: {reason}</div>)}
    </details>}
  </div>;
  return <div role="status" aria-label="조건검색 데이터 준비" className="text-xs text-fg-dim">
    평가 완료 {run.evaluated.toLocaleString()}/{run.total.toLocaleString()}종목
    {run.preparing > 0 && ` · 데이터 준비 중 ${run.preparing.toLocaleString()}`}
    {run.waiting > 0 && ` · 검증 대기 ${run.waiting.toLocaleString()}`}
    {run.failed > 0 && ` · 확인 실패 ${run.failed.toLocaleString()}`}
    {run.next_retry_at_ms != null && ` · 재시도 예정 ${new Date(run.next_retry_at_ms).toLocaleTimeString('ko-KR', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
    })}`}
    {Object.keys(run.errors).length > 0 && <details className="mt-1">
      <summary>확인 내용</summary>
      <ul>{Object.entries(run.errors).map(([code, reason]) => <li key={code}>{code}: {reason}</li>)}</ul>
    </details>}
  </div>;
}

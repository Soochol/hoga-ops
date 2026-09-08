import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from '../api/client';
import type { ConditionLeaf, HistoryCoverage, HistoryJob, ScanRequest } from '../api/screener';
import { ToolbarButton } from '../ui/PageShell';

const running = (job?: HistoryJob | null) => !!job && ['queued', 'collecting', 'deriving'].includes(job.status);
// Backend models reorder keys and materialize omitted defaults on a round trip.
// Normalize those differences before associating a server job with the editor.
function conditionParams(leaf: ConditionLeaf) {
  switch (leaf.type) {
    case 'ma': return { ...leaf.params, source: leaf.params.source ?? 'close' };
    case 'high_off_peak': return { ...leaf.params, side: leaf.params.side ?? 'within' };
    case 'ask_depth_new_high': case 'bid_depth_new_high':
    case 'ask_depth_new_high_period': case 'bid_depth_new_high_period':
      return { ...leaf.params, threshold_pct: leaf.params.threshold_pct ?? 100 };
    case 'ask_depth_renewal': case 'bid_depth_renewal':
      return { ...leaf.params, start_hhmm: leaf.params.start_hhmm ?? 1200, threshold_pct: leaf.params.threshold_pct ?? 100 };
    default: return leaf.params;
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item != null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
const signature = (request: ScanRequest) => JSON.stringify(canonical({
  conditions: request.conditions.map(leaf => ({ ...leaf, params: conditionParams(leaf) })),
  universe: { markets: request.universe?.markets ?? [], exclude_etf: request.universe?.exclude_etf ?? true,
    exclude_halted: request.universe?.exclude_halted ?? false, scopes: request.universe?.scopes ?? [] },
  basis: request.basis ?? 'eod', limit: request.limit ?? 1000 }));
const labels: Record<string, string> = { queued: '대기', collecting: '일봉 수집', deriving: '디스크 저장',
  complete: '완료', partial: '일부 데이터 부족', failed: '실패', interrupted: '중단됨' };

const failureLabels: Record<string, string> = {
  vendor_history_incomplete: '공급자가 요청한 일봉을 모두 제공하지 않았습니다',
  history_changed_during_collection: '수집 중 저장 이력이 변경되었습니다. 다시 수집해 주세요',
  factor_unavailable: '거래량 보정 기준을 확인할 수 없습니다',
  adjusted_volume_mismatch: '보정 거래량이 일치하지 않아 저장을 보류했습니다',
  adjusted_price_mismatch: '보정 가격이 일치하지 않아 저장을 보류했습니다',
  kiwoom_credentials_unavailable: '서버의 키움 API 연결 설정이 필요합니다',
  vendor_invalid_rows: '공급자 응답에 유효하지 않은 일봉이 있습니다',
  calendar_unavailable: '해당 구간의 거래일 달력이 없습니다',
};

export function HistoryCollection({ request, coverage, onComplete }: {
  request: ScanRequest; coverage?: HistoryCoverage | null; onComplete: () => void;
}) {
  const client = useQueryClient();
  const enabled = request.conditions.some(c => c.type === 'new_high_vol' && 'mode' in c.params);
  const query = useQuery({ queryKey: ['screener-history-job'], enabled,
    queryFn: () => apiCall<HistoryJob | null>('/api/screener/history/jobs/current'),
    refetchInterval: q => running(q.state.data) ? 2000 : false });
  const create = useMutation({ mutationFn: () => apiCall<HistoryJob>('/api/screener/history/jobs', {
    method: 'POST', body: JSON.stringify(request),
  }), onSuccess: job => client.setQueryData(['screener-history-job'], job) });
  const cancel = useMutation({ mutationFn: () => apiCall<HistoryJob>(`/api/screener/history/jobs/${query.data?.id}/cancel`, {
    method: 'POST',
  }), onSuccess: job => client.setQueryData(['screener-history-job'], job) });
  const completed = useRef<string | null>(null);
  const callback = useRef(onComplete);
  callback.current = onComplete;
  const job = query.data;
  const key = signature(request);
  const matchingJob = !!job && signature(job.request) === key;
  useEffect(() => {
    if (job && ['complete', 'partial'].includes(job.status) && completed.current !== job.id
      && matchingJob) {
      completed.current = job.id;
      callback.current();
    }
  }, [job, key, matchingJob]);
  if (!enabled) return null;
  const missing = new Set(coverage?.incomplete.map(item => item.code)).size;
  const error = create.error ?? cancel.error ?? query.error;
  return <div className="flex flex-col gap-2 border border-border rounded-md p-3 text-sm" aria-label="과거 일봉 수집">
    <p>{coverage ? `대상 ${coverage.total}종목 · 전체 기간 평가 가능 ${coverage.complete}종목 · 이력 확인 필요 ${missing}종목`
      : '조회하면 필요한 과거 일봉의 보유 상태를 확인합니다.'}</p>
    {missing > 0 && <p className="text-fg-dim">결과는 충분한 비교 이력에서 확인된 종목입니다. 부족한 일봉을 수집해 디스크에 저장할 수 있습니다.</p>}
    {job && !matchingJob && <p className="text-fg-dim">아래 작업은 다른 검색 조건의 수집입니다.
      {running(job) ? ' 완료 또는 중단 후 현재 조건으로 수집할 수 있습니다.' : ' 현재 조건은 새로 수집합니다.'}</p>}
    {job && <p role="status">{labels[job.status] ?? job.status} · {job.done}/{job.total}종목 · 저장 {job.written_rows.toLocaleString()}행
      {job.current_code && ` · ${job.current_code}`}</p>}
    {job && Object.keys(job.errors).length > 0 && <details><summary>수집 실패 {Object.keys(job.errors).length}건</summary>
      <ul>{Object.entries(job.errors).map(([code, reason]) => <li key={code}>{code}: {failureLabels[reason] ?? reason}</li>)}</ul></details>}
    {error && <p role="alert">{error.message}</p>}
    <div className="flex gap-2">
      <ToolbarButton disabled={running(job) || create.isPending} onClick={() => create.mutate()}>
        {create.isPending ? '수집 준비 중…' : matchingJob && job?.status === 'interrupted' ? '남은 일봉 수집 재개' : '과거 일봉 수집'}
      </ToolbarButton>
      {running(job) && <ToolbarButton disabled={cancel.isPending || job?.cancel_requested} onClick={() => cancel.mutate()}>
        {job?.cancel_requested ? '중단 요청됨' : matchingJob ? '수집 중단' : '다른 조건 수집 중단'}</ToolbarButton>}
      {job && !running(job) && <ToolbarButton onClick={onComplete}>다시 조회</ToolbarButton>}
    </div>
  </div>;
}

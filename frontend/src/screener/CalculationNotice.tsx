import { isRankCondition } from './rankConditions';
import { useState } from 'react';
import { apiCall } from '../api/client';
import type { ScanRequest, ScreenerResponse } from '../api/screener';
import type { PanelScan } from '../state/screenerPanel';
import { ToolbarButton } from '../ui/PageShell';
import { calculationLabel } from './calculationPolicy';

const reasons: Record<string, string> = {
  share_evidence_unavailable: '주식 수 변환 이력 미확인', vendor_price_unavailable: '공급자 수정 가격 부족',
  missing_history: '원본 일봉 부족', insufficient_history: '비교 기간 부족',
  original_observation_conflict: '원본과 공급자 관측값 충돌', invalid_daily_rows: '원본 일봉 오류',
  calendar_unavailable: '거래일 달력 부족',
};

export function CalculationNotice({ scan }: { scan: PanelScan | null }) {
  const [saved, setSaved] = useState<{ execution: string; snapshot: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (scan?.calculation?.policy !== 'separate_bases_v2') return null;
  const calculation = scan.calculation;
  const counts = new Map<string, Set<string>>();
  for (const item of scan.barCoverage?.incomplete ?? []) {
    const codes = counts.get(item.reason) ?? new Set<string>();
    codes.add(item.code); counts.set(item.reason, codes);
  }
  const request: ScanRequest | null = (() => {
    try { return JSON.parse(scan.requestJson ?? '{}') as ScanRequest; } catch { return null; }
  })();
  const archivable = request?.calculation_policy === 'separate_bases_v2' && request.conditions?.every(leaf =>
    !isRankCondition(leaf) && !leaf.type.includes('depth')
    && !('timeframe' in leaf.params && leaf.params.timeframe?.endsWith('m')));
  const save = async () => {
    if (!request) return;
    setBusy(true); setError(null);
    try {
      const response = await apiCall<ScreenerResponse>('/api/screener/executions', {
        method: 'POST', body: JSON.stringify({ ...request, basis: 'eod', snapshot_id: calculation.snapshot_id }),
      });
      const id = response.calculation?.execution_id;
      if (id && response.calculation?.snapshot_id) setSaved({ execution: id, snapshot: response.calculation.snapshot_id });
    } catch (failure) { setError(failure instanceof Error ? failure.message : '실행 기록 보존 실패'); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-1 text-xs text-fg-dim" aria-label="계산 기준 안내">
    <p>{calculationLabel(calculation.policy)} · 수정 가격 기준일 {calculation.adjusted_as_of ?? '미준비'}</p>
    {scan.warnings.includes('separate_bases_not_prepared') && <p>새 기준 일봉을 먼저 준비해 주세요.</p>}
    {scan.barCoverage && <p>대상 {scan.barCoverage.total}종목 · 평가 가능 {scan.barCoverage.complete}종목
      {' · '}확인 필요 {scan.barCoverage.total - scan.barCoverage.complete}종목</p>}
    {[...counts].map(([reason, codes]) => <p key={reason}>{reasons[reason] ?? reason}: {codes.size}종목</p>)}
    {counts.has('share_evidence_unavailable') && <p>검증된 수량 이력 등록이 필요합니다. 실제 거래량을 선택하면 수량 환산 없이 비교합니다.</p>}
    <p>차트는 현재 기준으로 열리며, 이 조회의 가격 버전과 다를 수 있습니다.</p>
    {archivable && calculation.snapshot_id && <div>
      <ToolbarButton disabled={busy} onClick={() => void save()}>{busy ? '보존 중…' : '이 스냅샷으로 확정 일봉 결과 보존'}</ToolbarButton>
      <p>확정 일봉으로 다시 계산한 결과와 입력을 보존합니다.</p>
    </div>}
    {saved?.snapshot === calculation.snapshot_id && <p>보존된 실행 ID: <span className="font-data break-all">{saved.execution}</span></p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

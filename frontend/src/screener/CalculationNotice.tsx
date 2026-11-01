import { isRankCondition } from './rankConditions';
import { useState } from 'react';
import { apiCall } from '../api/client';
import type { ScanRequest, ScreenerResponse } from '../api/screener';
import type { PanelScan } from '../state/screenerPanel';
import { ToolbarButton } from '../ui/PageShell';
import { calculationLabel } from './calculationPolicy';

export function CalculationNotice({ scan }: { scan: PanelScan | null }) {
  const [saved, setSaved] = useState<{ execution: string; snapshot: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (scan?.calculation?.policy !== 'separate_bases_v2') return null;
  const calculation = scan.calculation;
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, basis: 'eod', snapshot_id: calculation.snapshot_id }),
      });
      const id = response.calculation?.execution_id;
      if (id && response.calculation?.snapshot_id) setSaved({ execution: id, snapshot: response.calculation.snapshot_id });
    } catch (failure) { setError(failure instanceof Error ? failure.message : '실행 기록 보존 실패'); }
    finally { setBusy(false); }
  };
  return <details className="text-xs text-fg-dim" aria-label="계산 기준 안내">
    <summary>계산 기준</summary>
    <p>{calculationLabel(calculation.policy)} · 수정 가격 기준일 {calculation.adjusted_as_of ?? '미준비'}</p>
    {scan.warnings.includes('separate_bases_not_prepared') && <p>검색에 필요한 일봉을 자동으로 준비합니다.</p>}
    <p>차트는 현재 기준으로 열리며, 이 조회의 가격 버전과 다를 수 있습니다.</p>
    {archivable && calculation.snapshot_id && <div>
      <ToolbarButton disabled={busy} onClick={() => void save()}>{busy ? '보존 중…' : '이 스냅샷으로 확정 일봉 결과 보존'}</ToolbarButton>
      <p>확정 일봉으로 다시 계산한 결과와 입력을 보존합니다.</p>
    </div>}
    {saved?.snapshot === calculation.snapshot_id && <p>보존된 실행 ID: <span className="font-data break-all">{saved.execution}</span></p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}

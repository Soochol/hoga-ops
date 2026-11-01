import { isRankCondition } from '../screener/rankConditions';
import { apiCall } from './client';
import type { ScanRequest, ScreenerResponse } from './screener';
import { isHistoricalCondition, screenerRequestKey } from './screenerRequest';

export type ScreenerRunStatus = 'queued' | 'preparing' | 'complete' | 'partial' | 'failed' | 'interrupted';
export interface ScreenerRun {
  id: string;
  status: ScreenerRunStatus;
  request: ScanRequest;
  total: number;
  evaluated: number;
  preparing: number;
  waiting: number;
  failed: number;
  next_retry_at_ms: number | null;
  errors: Record<string, string>;
  revision: number;
  result_revision: number;
  result: ScreenerResponse | null;
  started_at_ms: number;
  updated_at_ms: number;
  minute_date?: string | null;
}

const STORAGE_KEY = 'screener.active-runs.v1';
export const preparationKey = (body: ScanRequest) => JSON.stringify([screenerRequestKey(body), body.venue ?? 'KRX']);
export const needsDailyPreparation = (body: ScanRequest) => !body.snapshot_id && (
  body.calculation_policy === 'separate_bases_v2'
    ? body.conditions.some(leaf => !leaf.type.includes('depth') && !isRankCondition(leaf)
      && !('timeframe' in leaf.params && leaf.params.timeframe?.endsWith('m')))
    : body.conditions.some(isHistoricalCondition));
export const needsPreparation = (body: ScanRequest) => !body.snapshot_id && (
  body.conditions.some(leaf => 'timeframe' in leaf.params && leaf.params.timeframe?.endsWith('m')) || needsDailyPreparation(body));

function activeRuns(): Record<string, string> {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>; }
  catch { return {}; }
}
export function activeRunId(body: ScanRequest): string | undefined {
  return activeRuns()[preparationKey(body)];
}
function remember(body: ScanRequest, run: ScreenerRun) {
  const entries = activeRuns();
  const key = preparationKey(body);
  if (['queued', 'preparing', 'interrupted'].includes(run.status)) entries[key] = run.id;
  else delete entries[key];
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(entries).slice(-8)))); }
  catch { /* storage is optional; the server still owns the work */ }
}

function pause(signal: AbortSignal, delay: number) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { window.clearTimeout(timer); reject(signal.reason); };
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function runPreparedScan(body: ScanRequest, signal: AbortSignal,
  progress: (run: ScreenerRun) => void, resumeId?: string): Promise<ScreenerResponse> {
  const start = () => apiCall<ScreenerRun>('/api/screener/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  let run: ScreenerRun;
  try {
    run = resumeId ? await apiCall<ScreenerRun>(`/api/screener/runs/${resumeId}`, { signal }) : await start();
  } catch (error) {
    if (!resumeId || (error as { status?: number }).status !== 404) throw error;
    run = await start();
  }
  let result: ScreenerResponse | null = null;
  let revision: number | undefined;
  let restarted = false;
  for (;;) {
    signal.throwIfAborted();
    remember(body, run);
    progress(run.status === 'interrupted' ? { ...run, result: null } : run);
    if (run.result) { result = run.result; revision = run.result_revision; }
    if (run.status === 'interrupted' && !restarted) {
      restarted = true;
      run = await start();
      continue;
    }
    if (run.status === 'failed' || run.status === 'interrupted') {
      throw new Error(run.errors.run ?? '데이터 준비를 완료하지 못했습니다. 다시 조회해 주세요.');
    }
    if (run.status === 'complete' || run.status === 'partial') {
      if (!result) throw new Error('검색 결과를 읽지 못했습니다. 다시 조회해 주세요.');
      return result;
    }
    await pause(signal, run.next_retry_at_ms ? Math.min(30_000, Math.max(750, run.next_retry_at_ms - Date.now())) : 750);
    const suffix = revision === undefined ? '' : `?after_revision=${revision}`;
    run = await apiCall<ScreenerRun>(`/api/screener/runs/${run.id}${suffix}`, { signal });
  }
}

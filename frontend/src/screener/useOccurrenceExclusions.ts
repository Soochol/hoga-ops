import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  excludeScreenerOccurrence, listScreenerExclusions, restoreScreenerOccurrence, runScan,
  type ConditionLeaf, type ScanRequest, type ScreenerExclusion, type ScreenerExclusionsFile, type ScreenerOccurrence,
} from '../api/screener';
import { useScreenerPanelStore, type PanelScan } from '../state/screenerPanel';

const KEY = ['screener-occurrence-exclusions'];

export function scanConditions(scan: PanelScan | null): ConditionLeaf[] {
  try {
    const request: ScanRequest = JSON.parse(scan?.requestJson ?? scan?.scanKey ?? '{}');
    return Array.isArray(request.conditions) ? request.conditions : [];
  } catch { return []; }
}

/** Apply exclusions to cached/in-flight results; SQL owns replenishing the limit. */
export function pruneExcludedRows(scan: PanelScan, exclusions: ScreenerExclusion[]): PanelScan {
  const keys = new Set(exclusions.map(e => `${e.condition_key}:${e.code}:${e.date}`));
  let changed = false;
  const rows = scan.rows.flatMap(row => {
    if (!row.occurrences?.length) return [row];
    const remaining = row.occurrences.filter(o => !keys.has(`${o.condition_key}:${row.code}:${o.date}`));
    if (remaining.length === row.occurrences.length) return [row];
    changed = true;
    const required = new Set(row.occurrences.map(o => o.condition_id));
    const active = new Set(remaining.map(o => o.condition_id));
    if ([...required].some(id => !active.has(id))) return [];
    return [{ ...row, occurrences: remaining,
      history_matches: row.history_matches?.filter(m => remaining.some(o => o.condition_id === m.condition_id && o.date === m.date)) }];
  });
  return changed ? { ...scan, rows, dataStale: true } : scan;
}

function pruneCurrent(exclusions: ScreenerExclusion[]) {
  const store = useScreenerPanelStore.getState();
  if (!store.lastScan) return;
  const next = pruneExcludedRows(store.lastScan, exclusions);
  if (next !== store.lastScan) store.setLastScan(next);
}

// One refresh per shared scan. Never replace a newer search with an old response.
let refreshGeneration = 0;
async function refreshResults() {
  const store = useScreenerPanelStore.getState();
  const before = store.lastScan;
  const requestJson = before?.requestJson ?? before?.scanKey;
  if (!before || !requestJson) return;
  const generation = ++refreshGeneration;
  try {
    const response = await runScan(JSON.parse(requestJson));
    if (generation !== refreshGeneration || useScreenerPanelStore.getState().lastScan !== before) return;
    store.setLastScan({ ...before, interactionStartedAtMs: before.interactionStartedAtMs ?? before.scannedAtMs, rows: response.rows, scanStatus: response.status,
      warnings: response.warnings, hasMore: response.has_more,
      historyCoverage: response.history_coverage, depthValues: response.depth_values ?? null,
      intradayFailure: response.intraday_failure, scannedAtMs: response.scanned_at_ms ?? Date.now(), dataStale: false });
  } catch (error) {
    if (useScreenerPanelStore.getState().lastScan === before) store.markLastScanDataStale();
    throw error;
  }
}

export function useOccurrenceExclusions(scan: PanelScan | null) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: KEY, queryFn: listScreenerExclusions, refetchInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [lastExcluded, setLastExcluded] = useState<ScreenerExclusion | null>(null);
  const conditions = useMemo(() => scanConditions(scan), [scan?.requestJson, scan?.scanKey]);
  const signature = query.data ? query.data.exclusions.map(e => e.id).sort().join(',') : null;
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (signature === null) return;
    const hadPrevious = previous.current !== null;
    const changed = previous.current !== signature;
    previous.current = signature;
    // Prune before taking the refresh snapshot so the response is not discarded as stale.
    if (query.data) pruneCurrent(query.data.exclusions);
    // Initial hydration also refreshes persisted occurrence-aware results.
    const current = useScreenerPanelStore.getState().lastScan;
    if (changed && current && (hadPrevious || current.rows.length === 0 || current.rows.some(row => row.occurrences !== undefined)) && !pending.current) {
      void refreshResults().catch(() => setError('제외 목록은 저장되어 있지만 결과 갱신에 실패했습니다. 다시 조회해 주세요.'));
    }
  }, [signature]);
  useEffect(() => {
    if (query.data) pruneCurrent(query.data.exclusions);
  }, [query.data, scan]);

  const mutate = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
      await qc.invalidateQueries({ queryKey: KEY });
      const file = qc.getQueryData<Awaited<ReturnType<typeof listScreenerExclusions>>>(KEY);
      if (file) pruneCurrent(file.exclusions);
      try { await refreshResults(); }
      catch { setError('제외 목록은 저장되어 있지만 결과 갱신에 실패했습니다. 다시 조회해 주세요.'); }
    } catch { setError('제외 목록을 저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { pending.current = false; setBusy(false); }
  };
  return {
    exclusions: query.data?.exclusions ?? [], busy, error: error ?? (query.isError ? '제외 목록을 불러오지 못했습니다.' : null),
    ready: query.isSuccess, conditions, lastExcluded,
    affectedOtherRows: (code: string, occurrence: ScreenerOccurrence) => {
      const events = scan?.rows.find(r => r.code === code)?.occurrences ?? [];
      return events.filter(e => e.condition_id === occurrence.condition_id).length === 1
        ? events.filter(e => e.condition_id !== occurrence.condition_id).length : 0;
    },
    exclude: (code: string, name: string, occurrence: ScreenerOccurrence) => {
      const condition = conditions.find(c => c.id === occurrence.condition_id);
      if (!condition) { setError('이 발생 건의 조회 조건이 없습니다. 다시 조회해 주세요.'); return; }
      void mutate(async () => {
        const entry = await excludeScreenerOccurrence({ condition, code, stock_name: name, date: occurrence.date });
        qc.setQueryData<ScreenerExclusionsFile>(KEY, old => ({ schema_version: 1,
          exclusions: [...(old?.exclusions ?? []).filter(e => e.id !== entry.id), entry] }));
        setLastExcluded(entry);
      });
    },
    restore: (entry: ScreenerExclusion) => void mutate(async () => {
      await restoreScreenerOccurrence(entry.id);
      qc.setQueryData<ScreenerExclusionsFile>(KEY, old => ({ schema_version: 1,
        exclusions: (old?.exclusions ?? []).filter(e => e.id !== entry.id) }));
      if (lastExcluded?.id === entry.id) setLastExcluded(null);
    }),
  };
}
export type OccurrenceExclusions = ReturnType<typeof useOccurrenceExclusions>;

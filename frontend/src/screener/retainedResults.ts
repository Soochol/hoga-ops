import type { PanelScan } from '../state/screenerPanel';
import { screenerRequestKey } from '../api/screenerRequest';
import type { ScanRequest } from '../api/screener';

/** A new request/save starts a new list; page and drawer may serialize keys differently. */
function sameSearch(previous: PanelScan, next: PanelScan): boolean {
  if (previous.savedId !== next.savedId || previous.savedUpdatedAtMs !== next.savedUpdatedAtMs
    || previous.basis !== next.basis) return false;
  const before = previous.requestJson ?? previous.scanKey;
  const after = next.requestJson ?? next.scanKey;
  if (!before || !after) return false;
  if (before === after) return true;
  try {
    const previousRequest = JSON.parse(before) as ScanRequest;
    const nextRequest = JSON.parse(after) as ScanRequest;
    return (previousRequest.venue ?? 'KRX') === (nextRequest.venue ?? 'KRX')
      && screenerRequestKey(previousRequest) === screenerRequestKey(nextRequest);
  } catch { return false; }
}

/** Missing data or a truncated response cannot establish that a stock stopped matching. */
function uncertainCodes(scan: PanelScan): Set<string> | null {
  if (scan.scanStatus !== 'ok' || scan.hasMore || scan.intradayFailure
    || scan.rankBasis?.source === 'unavailable' || scan.barCoverage?.realtime?.monitor_error) return null;
  const coverage = [scan.barCoverage, scan.dailyCoverage, scan.historyCoverage];
  if (coverage.some(c => c && c.complete < c.total && c.incomplete.length === 0)) return null;
  if (scan.warnings.some(warning => {
    if (warning === 'etf_filter_stale_master_unavailable' || warning === 'scope_universe_empty') return false;
    if (warning === 'bar_volume_partial' && scan.barCoverage?.incomplete.length) return false;
    if (warning === 'daily_observations_unavailable' && scan.dailyCoverage?.incomplete.length) return false;
    return true;
  })) return null;
  return new Set(coverage.flatMap(c => c?.incomplete.map(item => item.code) ?? []));
}

/** Keep the old position/evidence until dismissal. A fresh match removes its shade. */
export function retainMissingResults(previous: PanelScan | null, scan: PanelScan): PanelScan {
  if (!previous || !sameSearch(previous, scan)) return scan;
  const incoming = new Map(scan.rows.map(row => [row.code, row]));
  const previousCodes = new Set(previous.rows.map(row => row.code));
  const exited = new Set(previous.exitedCodes ?? []);
  const unknown = uncertainCodes(scan);
  const exitedCodes: string[] = [];
  const rows = previous.rows.map(row => {
    const fresh = incoming.get(row.code);
    if (fresh) return fresh;
    if ((unknown !== null && !unknown.has(row.code)) || exited.has(row.code)) exitedCodes.push(row.code);
    return row;
  });
  // Fresh entries use their server position; retained entries keep their place.
  // In particular, a restored stock must not be buried beyond the virtual viewport.
  for (const [index, row] of scan.rows.entries()) {
    if (!previousCodes.has(row.code)) rows.splice(Math.min(index, rows.length), 0, row);
  }
  // Preserve evidence only for retained stocks. Matching stocks use the fresh response.
  const depthValues = { ...scan.depthValues };
  for (const row of previous.rows) {
    if (!incoming.has(row.code) && previous.depthValues?.[row.code]) depthValues[row.code] = previous.depthValues[row.code];
  }
  return { ...scan, rows, exitedCodes,
    depthValues: Object.keys(depthValues).length ? depthValues : null,
    interactionStartedAtMs: scan.interactionStartedAtMs ?? previous.interactionStartedAtMs ?? previous.scannedAtMs };
}

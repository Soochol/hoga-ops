import type { PanelScan } from '../state/screenerPanel';

function stamp(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** Use server snapshot times; never turn the browser's clock into a data cutoff. */
export function scanBasisLabel(scan: Pick<PanelScan, 'basisAtMs' | 'fallbackBasisAtMs' | 'rows'>): string {
  if (scan.basisAtMs != null && Number.isFinite(scan.basisAtMs)) {
    const fallback = scan.fallbackBasisAtMs;
    if (fallback != null && Number.isFinite(fallback) && fallback !== scan.basisAtMs) {
      return `${stamp(scan.basisAtMs).slice(-5)} 기준 · 일부 종목 전일 데이터`;
    }
    return `${stamp(scan.basisAtMs)} 기준`;
  }
  // Legacy snapshots have a date but no recorded cutoff time. Do not invent one.
  const dates = [...new Set(scan.rows.flatMap(row => row.price_date ? [row.price_date] : []))].sort();
  if (!dates.length) return '기준 정보 없음';
  return `${dates[0]}${dates.length > 1 ? ` ~ ${dates.at(-1)}` : ''} 기준`;
}

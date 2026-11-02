import type { BarVolumeCoverage } from '../api/screener';

const SHORT_HISTORY = new Set(['insufficient_minute_history', 'insufficient_day_bars']);

export function minuteHistoryState(coverage?: BarVolumeCoverage | null): string | null {
  if (!coverage?.trading_date || coverage.complete !== 0 || !coverage.incomplete.length
    || coverage.incomplete.some(item => !SHORT_HISTORY.has(item.reason))) return null;
  const clock = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const minute = clock.getUTCHours() * 60 + clock.getUTCMinutes();
  return coverage.trading_date === clock.toISOString().slice(0, 10) && minute >= 540 && minute < 930
    ? '당일 분봉이 더 쌓여야 평가할 수 있습니다'
    : '선택 거래일의 비교 분봉이 부족합니다';
}

export function minuteHistoryDetail(scan: { barCoverage?: BarVolumeCoverage | null; requestJson?: string | null }): string | null {
  if (!minuteHistoryState(scan.barCoverage) || !scan.requestJson) return null;
  try {
    const request: unknown = JSON.parse(scan.requestJson);
    if (!request || typeof request !== 'object' || !('conditions' in request) || !Array.isArray(request.conditions)) return null;
    const pending = new Set(scan.barCoverage!.incomplete.map(item => item.condition_id));
    const counts = new Map<number, number>();
    for (const leaf of request.conditions) {
      if (!leaf || !pending.has(leaf.id) || !['new_high_vol', 'new_high_vol_today'].includes(leaf.type)) continue;
      const p = leaf.params;
      if (!p || !/^(1|3|5|10|15|30|60)m$/.test(p.timeframe) || !Number.isInteger(p.period) || p.period < 1) continue;
      const lookback = p.lookback ?? 1;
      if (!Number.isInteger(lookback) || lookback < 1) continue;
      const minutes = Number.parseInt(p.timeframe, 10);
      counts.set(minutes, Math.max(counts.get(minutes) ?? 0, p.period + lookback - 1));
    }
    if (!counts.size) return null;
    const needs = [...counts].sort(([a], [b]) => a - b).map(([minutes, count]) => `${minutes}분봉 ${count}개`).join(' · ');
    return `필요한 비교 자료: ${needs}. 해당 거래일 하루의 자료만 사용합니다.`;
  } catch { return null; }
}

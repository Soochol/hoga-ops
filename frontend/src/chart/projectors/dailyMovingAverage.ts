import { computeSMA, selectSource, type MASource } from './movingAverage';
import { unixMsToKSTDate } from '../../util/time';
import type { LivePastDailyCandle } from '../../api/livePastDailyCandles';

/**
 * 거래일(YYYYMMDD KST) → 일봉 SMA값 맵. (일봉 이동평균선 projector, ADR-0073)
 *
 * - `daily`는 방어적으로 t_ms 오름차순 정렬 후 계산.
 * - 키는 `unixMsToKSTDate(t_ms)` — 일봉 t_ms는 09:00 KST 앵커라 거래일과 일치
 *   (실데이터 검증 2026-06-13; 회귀 테스트로 고정).
 * - `todayLiveClose != null`이면 오늘 in-progress 봉 반영: daily 마지막 행이
 *   `todayDate`면 그 값을 override, 아니면 `todayDate` 합성 행을 append. 오늘 값은
 *   현재가 close 프록시 — source가 close가 아니어도 close를 쓰며 마감 시 종가로 수렴.
 * - `period` 미달 구간(SMA=null)은 맵에 없음 → 그 거래일은 라인 미표시.
 */
export function computeDailyMaByDate(
  daily: readonly LivePastDailyCandle[],
  period: number,
  source: MASource,
  todayDate: string,
  todayLiveClose: number | null,
): Map<string, number> {
  const rows = [...daily]
    .sort((a, b) => a.t_ms - b.t_ms)
    .map((d) => ({ date: unixMsToKSTDate(d.t_ms), value: selectSource(d, source) }));

  if (todayLiveClose != null) {
    const last = rows[rows.length - 1];
    if (last && last.date === todayDate) {
      last.value = todayLiveClose;
    } else {
      rows.push({ date: todayDate, value: todayLiveClose });
    }
  }

  const sma = computeSMA(rows.map((r) => r.value), period);
  const map = new Map<string, number>();
  rows.forEach((r, i) => {
    const v = sma[i];
    if (v != null) map.set(r.date, v);
  });
  return map;
}

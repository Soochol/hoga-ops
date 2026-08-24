// 최대벽 강도 pane 의 계단 계산 — **순수**.
//
// pane 은 새 지표가 아니라 기존 「당일 최대벽」(체결된 벽, ADR-0156)의 다른 표현이다.
// 입력은 `usePeakWallRender` 가 이미 계산한(필터를 모두 통과해 실제로 그려지는)
// 세그먼트이고, 여기서는 그 벽들의 당일 누적 최댓값 계단만 만든다:
//
//   계단(t) = max{ 벽ᵢ.qty : 벽ᵢ 가 선 시각 ≤ t }      (거래일 경계에서 리셋)
//
// 계단의 마지막 높이 = 캔들 pane 수평선의 값 — 두 표면이 같은 계산 결과를 나눠
// 쓰므로 어긋날 수 없다. 판정을 다시 하지 않는 것이 이 모듈의 요점이다
// (docs/research/2026-08-24-peak-wall-pane-implementation-plan.md §0).

import type { LineData, Time, WhitespaceData } from 'lightweight-charts';
import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { PeakWallSegment } from './PeakWallSegmentsPrimitive';

export type PeakWallStepPoint = LineData<Time> | WhitespaceData<Time>;

/**
 * 그려지는 세그먼트 → 봉별 당일 누적 최대 계단.
 *
 * - 벽이 선 시각은 `segment.peakTime` 이다 — `buildPeakWallSegments` 가 이미
 *   **캔들 버킷에 스냅**해 만든 가상초라(`snapPeakMsToCandle`), 계단이 오르는 x 가
 *   정확히 그 봉 위에 놓인다. 좌표 변환을 다시 하지 않는다(`peakWallRankArrows` 가
 *   같은 이유로 `axis.toReal` 역변환을 안 쓴다).
 * - 거래일 판정은 `axis.findByVirtual`(캔들이 속한 세그먼트 인덱스)로 한다.
 *   인덱스가 바뀌면 running max 를 리셋한다.
 * - 동률은 **먼저 도달한 것을 유지**한다(strict `>`) — `foldAskPeak` 의
 *   "동률 비교체(먼저 도달 유지)" 규약 미러.
 * - 그날 첫 벽이 서기 전의 캔들은 점을 내지 않는다 — "당일 최대" 가 아직 없다는
 *   정직한 표현이고, 선은 첫 벽 시점에서 시작한다.
 * - **거래일 사이는 whitespace 로 끊는다.** LineSeries 는 시간 갭이 있어도 연속
 *   점을 직선으로 잇기 때문에, 리셋의 수직 낙하가 "값이 급락했다" 로 오독된다.
 *   whitespace 의 time 은 새 날 첫 값 점 1초 앞 — 캔들 간격(≥60s) 안의 빈
 *   자리라 실제 점과 충돌하지 않는다.
 */
export function buildPeakWallStepPoints(
  segments: readonly PeakWallSegment[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  color: string,
): PeakWallStepPoint[] {
  if (segments.length === 0 || candles.length === 0 || axis.segments.length === 0) return [];

  // 벽 이벤트: 선 시각(가상초) 오름차순. dayIdx 는 흡수 시 방어용.
  const events = segments
    .map((s) => {
      const vsec = Number(s.peakTime);
      return { vsec, qty: s.qty, dayIdx: axis.findByVirtual(vsec * 1000) };
    })
    .filter((e) => Number.isFinite(e.vsec) && Number.isFinite(e.qty) && e.dayIdx >= 0)
    .sort((a, b) => a.vsec - b.vsec);
  if (events.length === 0) return [];

  const out: PeakWallStepPoint[] = [];
  let evIdx = 0;
  let currentDay = -2; // findByVirtual 은 -1(축 이전)을 반환할 수 있어 그와 겹치지 않는 초기값.
  let running: number | null = null;
  let pendingDayBreak = false;

  for (const c of candles) {
    const virtualMs = axis.toVirtual(c.ts_ms);
    const dayIdx = axis.findByVirtual(virtualMs);
    if (dayIdx < 0) continue; // 축 밖(미로드 구간) — 계단의 근거가 없다.
    if (dayIdx !== currentDay) {
      currentDay = dayIdx;
      running = null;
      // 이미 낸 점이 있으면 다음 값 점 직전에 whitespace 로 날 경계를 끊는다.
      pendingDayBreak = out.length > 0;
    }
    const vsec = virtualMs / 1000;
    // 이 캔들 시각까지 선 벽을 전부 흡수. 이벤트는 vsec 오름차순이고 거래일은
    // 가상축에서 연속이라 단일 포인터로 충분하다. dayIdx 대조는 스냅 경계 방어.
    while (evIdx < events.length && events[evIdx].vsec <= vsec) {
      const ev = events[evIdx];
      if (ev.dayIdx === dayIdx && (running === null || ev.qty > running)) running = ev.qty;
      evIdx += 1;
    }
    if (running === null) continue;
    if (pendingDayBreak) {
      out.push({ time: (vsec - 1) as Time });
      pendingDayBreak = false;
    }
    out.push({ time: vsec as Time, value: running, color });
  }
  return out;
}

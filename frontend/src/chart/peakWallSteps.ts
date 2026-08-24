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

import type { LineData, Time } from 'lightweight-charts';
import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { PeakWallSegment } from './PeakWallSegmentsPrimitive';
import { LINE_HIDDEN_COLOR, maskOutgoingConnector } from './util/auctionHide';

export type PeakWallStepPoint = LineData<Time>;

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
 * - **거래일 사이는 이전 날 마지막 점의 outgoing 색을 투명으로 끊는다**
 *   (`maskOutgoingConnector` + `LINE_HIDDEN_COLOR` — 총잔량 pane 이 마감 동시호가
 *   경계에서 쓰는 그 기법). ⚠ whitespace 로는 안 된다 — 실화면 검증에서
 *   lightweight-charts LineSeries 가 whitespace 를 **무시하고 선을 이어 그렸다**
 *   (setData 후 `series.data()` 에서도 사라짐). 리셋의 수직 낙하가 그대로 보이면
 *   "값이 급락했다" 로 오독된다.
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
  let lastVsec = Number.NEGATIVE_INFINITY;

  for (const c of candles) {
    // ⚠ 세션 밖 캔들(시간외 등)은 반드시 거른다 — `toVirtual` 은 축 밖 시각을 세션
    // 경계로 **클램프**하므로, 서로 다른 캔들이 같은 가상초를 얻어 lwc 의
    // "data must be asc ordered by time" 단언이 터진다(실사고 2026-08-24 — 아래
    // dayIdx 가드는 클램프 결과가 유효 인덱스라 이를 잡지 못한다). 캔들·거래량
    // 프로젝터가 같은 이유로 contains 를 거른다.
    if (!axis.contains(c.ts_ms)) continue;
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
    // 생산자 쪽 최종 불변식 — 어떤 입력에서든 같은 시각 점을 두 번 내지 않는다.
    // contains 필터가 알려진 원인(클램프)을 막고, 이 가드가 미지의 원인을 막는다
    // (lwc 는 위반 시 단언으로 차트 전체를 죽인다 — 점 하나 빠지는 쪽이 낫다).
    if (vsec <= lastVsec) continue;
    lastVsec = vsec;
    if (pendingDayBreak) {
      // 직전(이전 날 마지막) 점의 outgoing 투명 → 스텝의 **수평부**가 사라진다.
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      // 새 날 첫 점도 투명 → 스텝의 **수직부**까지 사라진다(실화면 검증: WithSteps 의
      // 수직 선분은 도착점 색을 쓴다 — 출발점만 가리면 수직 낙하가 남는다). 대가는
      // 새 날 선이 둘째 봉부터 보이는 것(첫 점의 outgoing 도 투명이므로) — 1봉 지연.
      out.push({ time: vsec as Time, value: running, ...LINE_HIDDEN_COLOR });
      pendingDayBreak = false;
      continue;
    }
    out.push({ time: vsec as Time, value: running, color });
  }
  return out;
}

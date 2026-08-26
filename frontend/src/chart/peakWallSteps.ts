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

/**
 * 미도달 벽 전용 계단 — **누적 최대가 아니다**.
 *
 * 「전체 최대벽」과 달리 미도달 계열은 **구성원이 빠져나간다**: 당일 극값이 전진해
 * 어떤 벽의 가격에 닿으면 그 벽은 그 시점부터 미도달이 아니다. 그래서 running max
 * (`buildPeakWallStepPoints`)를 쓰면 이미 깨진 벽이 계단 높이로 영원히 남는 **틀린
 * 선**이 된다 — 단조가 아닌 계열에 단조 빌더를 쓴 것이다.
 *
 * 대신 매 봉에서 그 시점 기준으로 다시 판정한다:
 *
 *   계단(t) = max{ 벽ᵢ.qty : 벽ᵢ.시각 ≤ t 이고 벽ᵢ 가 t 시점에 아직 미도달 }
 *
 * 미도달 판정의 극값은 **캔들에서** 만든다 — 세션 시작부터 t 까지의 누적 고가(ask)
 * /저가(bid).
 *
 * ## 후보가 비는 봉은 0 을 낸다 (2026-08-26 — 종전엔 선을 끊었다)
 *
 * 위 집합이 공집합이면 **그 시점에 미도달 벽이 없다**는 뜻이고, 그건 부재가 아니라
 * 값이다. 그래서 `0` 을 내되 점 색을 `absentColor`(계열 본색의 흐린 판) 로 바꾼다 —
 * "값이 0 으로 급락했다" 가 아니라 "이 구간엔 미도달 벽이 없었다" 로 읽히게 하는 것이
 * 요점이다. 종전 docstring 은 0 을 급락 오독 때문에 기각했는데, **오독은 데이터가
 * 아니라 표기의 문제**라 색으로 푼다.
 *
 * 기각 근거의 나머지 절반(「top-3 절단 때문에 0 이 거짓일 수 있다」)은 입력 쪽에서
 * 닫았다 — 계단 후보가 `toUnreachedStepPeakInputs` 로 그날 알려진 벽 전체가 됐다
 * (실측 3 → 33~150개). **그 확장 없이 0-fill 만 하면 종전 docstring 이 기각한 바로
 * 그것**이 되므로 둘은 한 묶음이다.
 *
 * ⚠ 그래도 0 이 100% 확실하지는 않다 — wire 가 top-3 밖 벽을 나르지 않는다. 남은
 * 근사는 조사 기록에 적혀 있다
 * (`docs/research/2026-08-26-peak-wall-pane-unreached-gap-review.md`).
 *
 * **벽 데이터가 아예 없는 거래일에는 아무것도 내지 않는다.** 캡처 누락과 "전부 도달"
 * 은 다른 상태이고, 전자에 0 을 그리면 하지 않은 주장을 하는 것이다. 판별은 그날에
 * 속한 후보가 하나라도 있는가로 한다.
 *
 * 거래일 경계는 종전대로 `maskOutgoingConnector` + 투명 첫 점으로 끊는다
 * (whitespace 로는 안 된다 — `buildPeakWallStepPoints` 머리말의 실측 참조).
 */
export function buildUnreachedStepPoints(
  segments: readonly PeakWallSegment[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  color: string,
  side: 'ask' | 'bid',
  absentColor: string,
): PeakWallStepPoint[] {
  if (segments.length === 0 || candles.length === 0 || axis.segments.length === 0) return [];
  const isAsk = side === 'ask';

  type Candidate = { vsec: number; qty: number; price: number };
  // 후보를 **거래일별로** 미리 나누고 각 날 안에서 기립 순으로 정렬한다. 봉마다 전체
  // 풀을 훑던 종전 구조는 후보가 3개일 때의 것이고, 풀이 그날 알려진 벽 전체로 넓어진
  // 지금은 O(봉수 × 풀크기) 가 그대로 비용이 된다(실측 400봉 × 150후보 / 일).
  const byDay = new Map<number, Candidate[]>();
  for (const s of segments) {
    const vsec = Number(s.peakTime);
    const dayIdx = axis.findByVirtual(vsec * 1000);
    if (!Number.isFinite(vsec) || !Number.isFinite(s.qty)
      || !Number.isFinite(s.price) || dayIdx < 0) continue;
    const bucket = byDay.get(dayIdx);
    const candidate = { vsec, qty: s.qty, price: s.price };
    if (bucket) bucket.push(candidate);
    else byDay.set(dayIdx, [candidate]);
  }
  if (byDay.size === 0) return [];
  for (const bucket of byDay.values()) bucket.sort((a, b) => a.vsec - b.vsec);

  const out: PeakWallStepPoint[] = [];
  let currentDay = -2;
  let dayExtreme: number | null = null;
  let pendingDayBreak = false;
  let lastVsec = Number.NEGATIVE_INFINITY;
  let dayCandidates: Candidate[] = [];
  let nextCandidate = 0;
  /** 아직 도달당하지 않은 후보만 남는다 — 극값은 단조라 이탈은 **영구적**이고,
   *  한 번 지운 후보를 다시 볼 일이 없다. */
  let alive: Candidate[] = [];

  for (const c of candles) {
    // 세션 밖 캔들 제외 — 사유는 buildPeakWallStepPoints 의 같은 가드 주석 참조.
    if (!axis.contains(c.ts_ms)) continue;
    const virtualMs = axis.toVirtual(c.ts_ms);
    const dayIdx = axis.findByVirtual(virtualMs);
    if (dayIdx < 0) continue;
    if (dayIdx !== currentDay) {
      currentDay = dayIdx;
      dayExtreme = null;
      pendingDayBreak = out.length > 0;
      dayCandidates = byDay.get(dayIdx) ?? [];
      nextCandidate = 0;
      alive = [];
    }
    // 그날 벽 데이터 자체가 없다 — 0 을 주장할 근거가 없으므로 점을 내지 않는다.
    if (dayCandidates.length === 0) continue;

    // 당일 누적 극값 — 세션 시작부터 이 봉까지.
    const level = isAsk ? c.high : c.low;
    if (Number.isFinite(level)) {
      dayExtreme = dayExtreme === null
        ? level
        : (isAsk ? Math.max(dayExtreme, level) : Math.min(dayExtreme, level));
    }

    const vsec = virtualMs / 1000;
    while (nextCandidate < dayCandidates.length
      && dayCandidates[nextCandidate].vsec <= vsec) {
      alive.push(dayCandidates[nextCandidate]);
      nextCandidate += 1;
    }

    // 살아 있는 후보를 훑으며 도달한 것을 제자리에서 걷어내고 최댓값을 고른다.
    let best: number | null = null;
    let kept = 0;
    for (const candidate of alive) {
      // 미도달 = 극값이 아직 이 가격을 지배하지 못했다(ask: price > 고가).
      const unreached = dayExtreme === null
        || (isAsk ? candidate.price > dayExtreme : candidate.price < dayExtreme);
      if (!unreached) continue;
      alive[kept] = candidate;
      kept += 1;
      if (best === null || candidate.qty > best) best = candidate.qty;
    }
    alive.length = kept;

    // 생산자 쪽 최종 불변식 — 어떤 입력에서든 같은 시각 점을 두 번 내지 않는다
    // (lwc 는 위반 시 단언으로 차트 전체를 죽인다 — 점 하나 빠지는 쪽이 낫다).
    if (vsec <= lastVsec) continue;
    lastVsec = vsec;
    if (pendingDayBreak) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time: vsec as Time, value: best ?? 0, ...LINE_HIDDEN_COLOR });
      pendingDayBreak = false;
      continue;
    }
    out.push({
      time: vsec as Time,
      value: best ?? 0,
      color: best === null ? absentColor : color,
    });
  }
  return out;
}

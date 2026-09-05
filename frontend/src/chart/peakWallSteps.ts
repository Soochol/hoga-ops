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
import type { AskPeakCandidate, Candle } from '../api/types';
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
 * 최대벽 강도 pane 의 **봉별 모드** 계단 — 누적이 아니라 **봉마다 독립**이다.
 *
 *   점(봉) = max{ 벽ᵢ.qty : 벽ᵢ 가 그 봉 안에서 체결됐다 }   (없으면 0)
 *
 * `buildPeakWallStepPoints`(누적 running max)와 같은 벽들을 다른 축으로 읽는다.
 * 저쪽은 "그 시점까지 가장 컸던 벽" 이라 단조이고, 이쪽은 "그 봉에서 가장 크게
 * 체결된 벽" 이라 오르내린다. 사용자 요청(2026-09-05)의 계열이 이것이다.
 *
 * ## 입력이 세그먼트가 아니라 **원 후보 배열**인 이유
 *
 * 이 모드는 **MA 필터를 우회한다**(사용자 결정). 두 MA 필터의 목적은 "현재가 근처의
 * 벽을 걷어내는 것" 인데, 체결된 벽은 정의상 그 봉의 가격이 닿은 벽이라 정확히 그
 * 대역에 산다 — 걸면 추세장에서 대부분의 봉이 비어 이 모드가 답하는 질문 자체가
 * 지워진다. 세그먼트(`buildPeakWallOverlaySegments` 산물)는 필터를 이미 통과한
 * 것이므로 여기서 쓸 수 없고, 그래서 wire 후보(`traded_bar_peaks`)를 직접 받는다.
 *
 * ## 1분 후보 → N분 봉 접기
 *
 * 후보는 **항상 1분 해상도**로 온다(백엔드가 봉별로 접지 않는다 — `AskPeak` 필드
 * 주석). 굵은 봉은 여기서 접는데, max 가 결합적이라 "1분 값들의 max" 가 그 봉을
 * 직접 계산한 값과 같다. 캔들 배열이 곧 봉 경계라 축 변환도 한 번뿐이다.
 *
 * ## 값이 없는 봉은 **0** 이다(점을 빼지 않는다)
 *
 * "그 봉에서 체결된 벽이 없었다" 가 이 계열에서는 **참인 관측**이라 0 이 정직하다.
 * 미도달 계단이 빈 구간에 0 을 그리지 않는 것과 반대인데, 저기서는 0 이 "미도달 벽이
 * 0주" 라는 **틀린 문장**이 되기 때문이다(같은 파일의 그 docstring 참조). 점을 빼면
 * lwc 가 앞뒤를 이어 그려(whitespace 무시) 없던 벽이 그 구간에 걸친 것처럼 보인다.
 */
export function buildPeakWallBarPoints(
  candidates: readonly AskPeakCandidate[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  color: string,
): PeakWallStepPoint[] {
  if (candidates.length === 0 || candles.length === 0 || axis.segments.length === 0) return [];

  // 후보를 가상초로 — 축 밖(미로드 구간)은 근거가 없으므로 버린다.
  const events = candidates
    .map((c) => {
      if (!Number.isFinite(c.t_ms) || !axis.contains(c.t_ms)) return null;
      const virtualMs = axis.toVirtual(c.t_ms);
      return { vsec: virtualMs / 1000, qty: c.qty, dayIdx: axis.findByVirtual(virtualMs) };
    })
    .filter((e): e is { vsec: number; qty: number; dayIdx: number } =>
      e !== null && Number.isFinite(e.qty) && e.dayIdx >= 0)
    .sort((a, b) => a.vsec - b.vsec);
  if (events.length === 0) return [];

  // 캔들도 같은 필터를 통과한 것만 — 세션 밖 캔들은 `toVirtual` 이 경계로 **클램프**해
  // 서로 다른 캔들이 같은 가상초를 얻는다(누적 빌더의 그 사고와 같은 원인).
  const bars: { vsec: number; dayIdx: number }[] = [];
  for (const c of candles) {
    if (!axis.contains(c.ts_ms)) continue;
    const virtualMs = axis.toVirtual(c.ts_ms);
    const dayIdx = axis.findByVirtual(virtualMs);
    if (dayIdx < 0) continue;
    const vsec = virtualMs / 1000;
    // 같은 시각 점을 두 번 내지 않는다(lwc 는 위반 시 차트를 죽인다).
    if (bars.length > 0 && vsec <= bars[bars.length - 1].vsec) continue;
    bars.push({ vsec, dayIdx });
  }
  if (bars.length === 0) return [];

  const out: PeakWallStepPoint[] = [];
  let evIdx = 0;
  let currentDay = -2;
  let pendingDayBreak = false;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    // 이 봉의 구간은 [bar.vsec, 다음 봉 vsec) — 마지막 봉은 상한이 없다.
    const nextVsec = i + 1 < bars.length ? bars[i + 1].vsec : Number.POSITIVE_INFINITY;
    let best = 0;
    while (evIdx < events.length && events[evIdx].vsec < nextVsec) {
      const ev = events[evIdx];
      // 봉보다 이른 후보(앞 봉이 전부 소진된 뒤 남은 것)는 이 봉의 값이 아니다.
      if (ev.vsec >= bar.vsec && ev.dayIdx === bar.dayIdx && ev.qty > best) best = ev.qty;
      evIdx += 1;
    }
    if (bar.dayIdx !== currentDay) {
      currentDay = bar.dayIdx;
      pendingDayBreak = out.length > 0;
    }
    if (pendingDayBreak) {
      // 거래일 사이를 잇는 선분을 지운다 — 누적 계단과 같은 기법이고 같은 이유다
      // (연결선이 남으면 날 경계의 값 변화가 하나의 움직임으로 읽힌다).
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time: bar.vsec as Time, value: best, ...LINE_HIDDEN_COLOR });
      pendingDayBreak = false;
      continue;
    }
    out.push({ time: bar.vsec as Time, value: best, color });
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
 * /저가(bid). 후보가 3개 이하라 봉마다 다시 훑어도 O(봉수 × 3) 이다.
 *
 * ⚠ **문서화된 근사**: 입력 세그먼트는 그 계열의 top-3(과거일은 wire 가 rank-1
 * 스칼라뿐이라 1개)이다. 따라서 이 선은 "모든 미도달 벽 중 최대" 가 아니라
 * "**top-3 후보 중** 그 시점에 미도달인 것의 최대" 다. 4위 이하가 살아남아도 보이지
 * 않는다 — 구백엔드 기록 필드가 없을 때 traded 계단이 top-3 으로 떨어지는 것과 같은
 * 등급의 근사이고, 그 이상은 wire 가 나르지 않는다.
 *
 * 후보가 전부 도달당해 계열이 비면 **0 을 그리지 않는다** — 0 은 "미도달 벽이 0주"
 * 라는 뜻이 되어 급락으로 오독된다. 대신 마지막 점의 outgoing 을 투명으로 끊어
 * 선을 거기서 멈춘다(거래일 경계와 같은 기법 — whitespace 는 lwc 가 무시한다).
 * 극값은 단조라 한 거래일 안에서 한 번 비면 그날은 다시 차지 않는다.
 */
export function buildUnreachedStepPoints(
  segments: readonly PeakWallSegment[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  color: string,
  side: 'ask' | 'bid',
): PeakWallStepPoint[] {
  if (segments.length === 0 || candles.length === 0 || axis.segments.length === 0) return [];
  const isAsk = side === 'ask';

  const events = segments
    .map((s) => {
      const vsec = Number(s.peakTime);
      return { vsec, qty: s.qty, price: s.price, dayIdx: axis.findByVirtual(vsec * 1000) };
    })
    .filter((e) => Number.isFinite(e.vsec) && Number.isFinite(e.qty)
      && Number.isFinite(e.price) && e.dayIdx >= 0);
  if (events.length === 0) return [];

  const out: PeakWallStepPoint[] = [];
  let currentDay = -2;
  let dayExtreme: number | null = null;
  let emittedToday = false;
  let closedToday = false;
  let pendingDayBreak = false;
  let lastVsec = Number.NEGATIVE_INFINITY;

  for (const c of candles) {
    // 세션 밖 캔들 제외 — 사유는 buildPeakWallStepPoints 의 같은 가드 주석 참조.
    if (!axis.contains(c.ts_ms)) continue;
    const virtualMs = axis.toVirtual(c.ts_ms);
    const dayIdx = axis.findByVirtual(virtualMs);
    if (dayIdx < 0) continue;
    if (dayIdx !== currentDay) {
      currentDay = dayIdx;
      dayExtreme = null;
      emittedToday = false;
      closedToday = false;
      pendingDayBreak = out.length > 0;
    }
    // 당일 누적 극값 — 세션 시작부터 이 봉까지.
    const level = isAsk ? c.high : c.low;
    if (Number.isFinite(level)) {
      dayExtreme = dayExtreme === null
        ? level
        : (isAsk ? Math.max(dayExtreme, level) : Math.min(dayExtreme, level));
    }
    if (closedToday) continue;

    const vsec = virtualMs / 1000;
    let best: number | null = null;
    for (const ev of events) {
      if (ev.dayIdx !== dayIdx || ev.vsec > vsec) continue;
      // 미도달 = 극값이 아직 이 가격을 지배하지 못했다(ask: price > 고가).
      const unreached = dayExtreme === null
        || (isAsk ? ev.price > dayExtreme : ev.price < dayExtreme);
      if (!unreached) continue;
      if (best === null || ev.qty > best) best = ev.qty;
    }

    if (best === null) {
      // 그날 이미 선을 그렸다면 여기서 끊는다(0 을 그리지 않는다).
      if (emittedToday) {
        maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
        closedToday = true;
      }
      continue;
    }
    if (vsec <= lastVsec) continue;
    lastVsec = vsec;
    if (pendingDayBreak) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time: vsec as Time, value: best, ...LINE_HIDDEN_COLOR });
      pendingDayBreak = false;
      emittedToday = true;
      continue;
    }
    out.push({ time: vsec as Time, value: best, color });
    emittedToday = true;
  }
  return out;
}

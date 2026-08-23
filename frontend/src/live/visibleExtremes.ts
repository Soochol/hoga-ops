import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';

export type Extreme = {
  /** 극값 가격 — 고가는 봉의 high, 저가는 봉의 low. */
  price: number;
  /** 극값 대비율(Extreme Gap) = (기준가 − price) / price × 100. 기준가 = 보이는 범위의 우측 끝
   *  (가장 최근) 캔들 close. CONTEXT.md `극값 대비율`. */
  pct: number;
  /** 극값 봉의 가상초(chart Time = axis.toVirtual(ts_ms)/1000) — x좌표 투영용. */
  virtualSec: number;
};

export type VisibleExtremes = { high: Extreme; low: Extreme } | null;

/** 가격만 담는 극값 쌍 — 라벨이 없는 선 전용이라 %·시각이 필요 없다. */
export type PriorDaysExtremes = { high: number; low: number } | null;

type Ref = { price: number; virtualSec: number };

function gap(basis: number, extreme: number): number {
  return ((basis - extreme) / extreme) * 100;
}

/**
 * 현재 보이는 뷰포트 범위 안에서 그려진 캔들의 최고가 봉/최저가 봉을 찾아 극값 대비율을 계산한다.
 * (CONTEXT.md: `극값 대비율` / `High/Low Extreme Labels`.) lightweight-charts 비의존 —
 * 좌표→픽셀 변환은 호출부(HighLowLabelsPrimitive.draw)가 담당한다.
 *
 *  - **기준가 = 보이는 범위의 우측 끝(가장 최근) 캔들 close**. 전체 데이터의 마지막 캔들이 아니라
 *    *현재 보이는* 범위의 rightmost라, 차트를 좌측으로 팬하면 기준가가 바뀌어 % 가 재계산된다.
 *    (라이브 끝에 있을 땐 마지막 캔들과 일치.) 우측 끝 = 가시 캔들 중 max virtualSec.
 *  - visibleRange 가 null 이거나 candles 가 비면 null (no-op).
 *  - `axis.contains(ts_ms)` 가 false인 봉(축에 안 그려짐) 제외. 마감 동시호가 봉은 그려지므로
 *    포함한다(그릴링 Q2 — 캔들 pane과 동일 기준; 캔들은 Auction Mask 비참여, ADR-0018/0029).
 *  - `visibleRange`(가상초) 밖의 봉 제외. 동률 극값은 첫 발생을 유지(스크롤 중 흔들림 방지).
 *  - 거래일별 리셋 없음 — 멀티데이 concat이어도 "보이는 범위의 전역 극값"(surge와 상반).
 */
export function computeVisibleExtremes(
  candles: readonly Candle[],
  axis: VirtualAxis,
  visibleRange: { from: number; to: number } | null,
): VisibleExtremes {
  if (visibleRange === null || candles.length === 0) return null;
  const { from, to } = visibleRange;

  let high: Ref | null = null;
  let low: Ref | null = null;
  // 기준가 = 우측 끝(가장 최근) 가시 캔들 close. virtualSec 최대인 봉을 한 패스에서 추적.
  let basisClose: number | null = null;
  let basisVSec = -Infinity;
  for (const c of candles) {
    if (!axis.contains(c.ts_ms)) continue;
    const virtualSec = axis.toVirtual(c.ts_ms) / 1000;
    if (virtualSec < from || virtualSec > to) continue;
    if (high === null || c.high > high.price) high = { price: c.high, virtualSec };
    if (low === null || c.low < low.price) low = { price: c.low, virtualSec };
    if (virtualSec > basisVSec) {
      basisVSec = virtualSec;
      basisClose = c.close;
    }
  }
  if (high === null || low === null || basisClose === null) return null;
  const basis = basisClose;
  return {
    high: { ...high, pct: gap(basis, high.price) },
    low: { ...low, pct: gap(basis, low.price) },
  };
}

/**
 * 보이는 범위에서 **가장 오른쪽 캔들이 속한 거래일을 통째로 뺀** 나머지 구간의
 * 최고가·최저가. "오늘 아직 넘지 못한 어제까지의 고점/저점" 을 지지·저항으로 읽는
 * 용도라 값만 돌려준다(라벨 없음 → %·시각 불필요).
 *
 *  - **컷오프는 그 거래일의 개장 시각**(`segment.sessionOpenMs`)이다. 캔들마다
 *    `findByReal` 을 부르지 않는 이유가 여기 있다 — 컷오프를 한 번만 구하면 이후는
 *    `ts_ms < cutoff` 단순 비교라 캔들당 O(1) 이다(이 함수는 매 프레임 돈다).
 *  - **뷰포트 기준이다**: 제외 대상은 "데이터의 마지막 날(오늘)" 이 아니라 *지금 보이는*
 *    범위의 우측 끝 날이다. 좌측으로 팬하면 기준일이 바뀌고 선도 따라 움직인다
 *    (`computeVisibleExtremes` 의 기준가와 같은 뷰포트 의존 규약).
 *  - 보이는 범위가 하루뿐이면 후보가 비어 **null**(선을 그리지 않는다).
 *  - ⚠ 후보는 `candles`, 즉 **로드된** 캔들이다. 이전 거래일이 부분 백필이면 그 부분의
 *    고저가 나온다 — 선은 멀쩡해 보이고 값만 틀리므로 눈으로는 구별되지 않는다.
 */
export function computePriorDaysExtremes(
  candles: readonly Candle[],
  axis: VirtualAxis,
  visibleRange: { from: number; to: number } | null,
): PriorDaysExtremes {
  if (visibleRange === null || candles.length === 0) return null;
  const { from, to } = visibleRange;

  const visible = (c: Candle): boolean => {
    if (!axis.contains(c.ts_ms)) return false;
    const virtualSec = axis.toVirtual(c.ts_ms) / 1000;
    return virtualSec >= from && virtualSec <= to;
  };

  // 1패스: 보이는 캔들 중 우측 끝(가장 최근)의 실 ms. 가상초로 비교하는 이유는
  // `computeVisibleExtremes` 와 동일 — 축이 세션 간 간극을 접으므로 실 ms 순서와
  // 화면 순서가 항상 같지는 않다.
  let lastTsMs: number | null = null;
  let lastVSec = -Infinity;
  for (const c of candles) {
    if (!visible(c)) continue;
    const virtualSec = axis.toVirtual(c.ts_ms) / 1000;
    if (virtualSec > lastVSec) {
      lastVSec = virtualSec;
      lastTsMs = c.ts_ms;
    }
  }
  if (lastTsMs === null) return null;

  const segIdx = axis.findByReal(lastTsMs);
  if (segIdx < 0) return null;
  const cutoffMs = axis.segments[segIdx].sessionOpenMs;

  // 2패스: 컷오프(그 거래일 개장) **미만**인 보이는 캔들만.
  let high: number | null = null;
  let low: number | null = null;
  for (const c of candles) {
    if (c.ts_ms >= cutoffMs || !visible(c)) continue;
    if (high === null || c.high > high) high = c.high;
    if (low === null || c.low < low) low = c.low;
  }
  if (high === null || low === null) return null;
  return { high, low };
}

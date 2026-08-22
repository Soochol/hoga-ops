import { useMemo } from 'react';
import type { Candle, PeakBase } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { computeSMA } from '../chart/projectors/movingAverage';
import { useActivePrefs } from '../state/chartPrefs';

/** 최대벽 이동평균 필터의 방향. 매도벽은 MA **위**만, 매수벽은 MA **아래**만 남긴다 —
 *  저항은 평균 위, 지지는 평균 아래에 선다는 읽기의 대칭. */
export type PeakMaFilterSide = 'ask' | 'bid';

export type PeakMaFilter = {
  side: PeakMaFilterSide;
  /** SMA 기간(봉 개수). 소스는 `close` 고정 — 이동평균선 지표의 슬롯(`movingAverages`)을
   *  참조하지 않는 이유는 모듈 상단 주석 참고. */
  period: number;
};

/**
 * 최대벽 세그먼트를 **그 벽이 걸린 봉의 이동평균선** 기준으로 거르는 순수 로직.
 *
 * 왜 여기(조립 단계)인가: 「MA 위/아래」는 후보 선정 규칙이 아니라 **표시 규칙**이다.
 * `useDayAskPeaks`/`useDayBidPeaks` 의 파생 4경로(배치·증분 × cutoff 유무)를 건드리면
 * #1477 의 지뢰밭에 들어가고, 레전드 값까지 조용히 바뀐다. 조립 단계(`buildAskPeak-
 * OverlaySegments`)에 걸면 선·도킹 라벨·고저 라벨 회피 rect 세 소비처가 한 구현을
 * 공유하고, 레전드는 종전대로 걸러지지 않은 값을 유지한다(MA 지표의 "숨김은 선만
 * 숨기고 레전드 값은 산다" 규칙 미러).
 *
 * 왜 전용 period pref 인가(이동평균선 슬롯 참조 기각): 슬롯은 **창 스코프 지표 상태**인데
 * 최대벽 옵션은 chartPrefs 다(스코프 불일치). 슬롯은 삭제 가능해 참조가 끊기면 필터가
 * 조용한 무동작이 되고, 슬롯마다 `source` 가 달라(hl2·ohlc4) 판정 기준이 사용자 모르게
 * 바뀐다. 그래서 기간만 받고 소스는 `close` 로 고정한다 — MA 선을 끈 채로도 필터는 산다.
 */
export function usePeakMaFilter(side: PeakMaFilterSide): PeakMaFilter | null {
  const enabled = useActivePrefs((prefs) => (
    side === 'ask' ? prefs.askPeakAboveMaEnabled : prefs.bidPeakBelowMaEnabled
  ));
  const period = useActivePrefs((prefs) => (
    side === 'ask' ? prefs.askPeakAboveMaPeriod : prefs.bidPeakBelowMaPeriod
  ));
  // 원시값 둘을 따로 구독하고 여기서 합친다 — selector 안에서 객체를 만들면 매 렌더
  // 새 참조가 나와 zustand 의 Object.is 비교가 항상 "변했다"로 읽는다.
  return useMemo(() => (enabled ? { side, period } : null), [side, enabled, period]);
}

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `candles`(ts_ms 오름차순)에서 `tMs` 이하 마지막 인덱스. 없으면 -1.
 *  `snapPeakMsToCandle` 과 같은 이진 탐색이되 ts 가 아니라 **인덱스**를 낸다 — SMA 배열이
 *  캔들 인덱스로 정렬돼 있어서다. */
export function candleIndexAtOrBefore(candles: readonly Candle[], tMs: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts_ms <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * `peaks` 를 이동평균 기준으로 거른다. 판정은 **벽 가격 vs 그 벽이 걸린 봉의 SMA** —
 * 현재가가 MA 위인지로 날 전체를 켜고 끄는 추세 게이팅이 **아니다**.
 *
 * ⚠ `candles` 는 `axis.contains` 로 거른 뒤 SMA 를 계산한다. `MovingAverageOverlay` 가
 * 화면의 MA 선을 그릴 때 쓰는 배열과 같아야 하기 때문 — 호출부가 넘기는 `cb.candles` 는
 * 필터 전 원본이라, 이 줄을 빼면 인덱스가 밀려 **그려진 선과 판정이 갈린다**.
 *
 * fail-open 규칙: SMA 가 없는 구간(warm-up), 캔들보다 앞선 벽, 유한하지 않은 가격은
 * **판정 불가로 보고 남긴다**. 데이터 부족으로 지표가 조용히 사라지는 쪽이 훨씬 나쁘다.
 */
export function filterPeaksAgainstMa<T extends PeakBase>(
  peaks: readonly T[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  intraMax: boolean,
  filter: PeakMaFilter | null,
): T[] {
  if (!filter || peaks.length === 0 || candles.length === 0) return [...peaks];
  const inSession = candles.filter((candle) => axis.contains(candle.ts_ms));
  if (inSession.length === 0) return [...peaks];
  const sma = computeSMA(inSession.map((candle) => candle.close), filter.period);
  return peaks.filter((peak) => {
    const price = intraMax ? peak.max_price : peak.price;
    const tMs = intraMax ? peak.max_t_ms : peak.t_ms;
    if (!finiteNumber(price) || !finiteNumber(tMs)) return true;
    const index = candleIndexAtOrBefore(inSession, tMs);
    if (index < 0) return true;
    const ma = sma[index];
    if (ma === null || ma === undefined) return true;
    return filter.side === 'ask' ? price > ma : price < ma;
  });
}

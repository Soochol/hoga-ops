import { memo, useEffect, useRef } from 'react';
import type { ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { Candle, WallSurgeEventWire } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import { formatQtyCompact } from '../util/formatQtyCompact';
import {
  WallSurgeMarkersPrimitive,
  type WallSurgeMarkerPoint,
} from '../chart/WallSurgeMarkersPrimitive';

/** 이벤트 시각을 그 시각이 속한 캔들(버킷)의 ts_ms 로 스냅.
 *
 * 캔들은 버킷 시작에 놓이는데(`downsample_candles`) 이벤트 `t_ms` 는 그 버킷 안의 임의
 * 스냅샷 시각이다. 그대로 두면 lwc 가 가상시각을 다음 캔들 쪽으로 보간해 **마커가 1캔들
 * 옆으로 밀린다** — 매도벽 점이 같은 이유로 스냅을 쓴다(`snapPeakMsToCandle`).
 *
 * candles 는 ts_ms 오름차순이라 이분탐색. tMs 가 첫 캔들보다 앞서면(미로드 구간) null 을
 * 내고 호출부가 원시 t_ms 로 폴백한다.
 */
export function snapEventMsToCandle(tMs: number, candles: readonly Candle[]): number | null {
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
  return ans >= 0 ? candles[ans].ts_ms : null;
}

/**
 * 이벤트를 마커 점으로 옮긴다(순수).
 *
 * **라벨은 상위 `labelCount` 건만** 붙인다(증가량 기준). 당일 최대벽은 전건 라벨을
 * 달지만 그건 선분이 몇 개일 때 얘기고, 하루 수십 건이 겹치면 라벨끼리 충돌한다 —
 * 나머지는 마커만 찍고 호버 툴팁이 맡는다(설계 문서 §4.2, 사용자 결정).
 */
export function buildWallSurgeMarkers(
  events: readonly WallSurgeEventWire[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  labelCount: number,
): WallSurgeMarkerPoint[] {
  if (events.length === 0) return [];
  // 라벨 대상은 증가량 상위 N — 원본 순서를 건드리지 않도록 인덱스만 뽑는다.
  const labelled = new Set(
    events
      .map((e, i) => ({ i, jump: e.jump }))
      .sort((a, b) => b.jump - a.jump)
      .slice(0, Math.max(0, labelCount))
      .map((x) => x.i),
  );
  const out: WallSurgeMarkerPoint[] = [];
  events.forEach((e, i) => {
    const snapped = snapEventMsToCandle(e.t_ms, candles) ?? e.t_ms;
    out.push({
      time: (axis.toVirtual(snapped) / 1000) as Time,
      price: e.price,
      side: e.side,
      outcome: e.outcome ?? null,
      reappear: e.kind === 'reappear',
      label: labelled.has(i) ? formatQtyCompact(e.qty) : undefined,
    });
  });
  return out;
}

type Props = {
  paneSeries: PaneSeriesMap;
  events: readonly WallSurgeEventWire[];
  candles: readonly Candle[];
  axis: VirtualAxis;
};

/** 캔들 시리즈에 호가벽 급증 마커를 붙인다.
 *
 * 생성은 series 핸들당 1회 — 봉·종목 전환에도 핸들이 유지되므로 매번 detach/attach 하지
 * 않는다(`LiveAskPeakSegments` 와 같은 수명 규칙).
 */
function LiveWallSurgeMarkersImpl({ paneSeries, events, candles, axis }: Props): null {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useActivePrefs((s) => s.wallSurgeEnabled);
  const labelCount = useActivePrefs((s) => s.wallSurgeLabelCount);
  const primRef = useRef<WallSurgeMarkersPrimitive | null>(null);

  useEffect(() => {
    if (!series) return;
    const prim = new WallSurgeMarkersPrimitive();
    series.attachPrimitive(prim);
    primRef.current = prim;
    return () => {
      try {
        series.detachPrimitive(prim);
      } catch {
        /* chart already torn down */
      }
      primRef.current = null;
    };
  }, [series]);

  useEffect(() => {
    const prim = primRef.current;
    if (!prim) return;
    prim.setData(enabled ? buildWallSurgeMarkers(events, candles, axis, labelCount) : []);
  }, [events, candles, axis, enabled, labelCount]);

  return null;
}

export const LiveWallSurgeMarkers = memo(LiveWallSurgeMarkersImpl);

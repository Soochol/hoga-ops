import { memo, useEffect, useRef } from 'react';
import type { ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { Candle, WallSurgeEventWire } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import { useWindowIndicator } from './workspace/windowView';
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
 * **라벨 선정은 여기서 하지 않는다** — 전건에 `label`·`jump` 를 채워 보내고 고르는 일은
 * 렌더러가 맡는다(`pickLabelledIndices`). 라벨을 제한하는 이유가 화면 위 충돌이라
 * 기준도 "화면에 든 것 중 상위 N" 이어야 하는데, 그 판정은 좌표가 나오는 draw 시점에만
 * 할 수 있다. build 단계에서 로드된 전 기간을 놓고 고르면 5거래일을 로드하고 하루만 볼 때
 * 상위 N 이 다른 날에 몰려 화면엔 한 개도 안 뜬다.
 */
export function buildWallSurgeMarkers(
  events: readonly WallSurgeEventWire[],
  candles: readonly Candle[],
  axis: VirtualAxis,
): WallSurgeMarkerPoint[] {
  return events.map((e) => {
    const snapped = snapEventMsToCandle(e.t_ms, candles) ?? e.t_ms;
    return {
      time: (axis.toVirtual(snapped) / 1000) as Time,
      price: e.price,
      side: e.side,
      outcome: e.outcome ?? null,
      reappear: e.kind === 'reappear',
      jump: e.jump,
      label: formatQtyCompact(e.qty),
    };
  });
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
 * 않는다(`LivePeakWallSegments` 와 같은 수명 규칙).
 */
function LiveWallSurgeMarkersImpl({ paneSeries, events, candles, axis }: Props): null {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  // 마스터 토글은 **indicator 슬라이스**다 — 지표 드로어의 다른 항목들과 같은 자리라야
  // 창별 스코프(멀티 창)와 프리셋이 함께 따라온다. 라벨 개수 같은 세부 옵션만 chartPrefs.
  const enabled = useWindowIndicator((s) => s.wallSurgeEnabled);
  const labelOn = useActivePrefs((s) => s.wallSurgeLabelEnabled);
  const labelCountPref = useActivePrefs((s) => s.wallSurgeLabelCount);
  const labelCount = labelOn ? labelCountPref : 0;
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
    prim.setData(enabled ? buildWallSurgeMarkers(events, candles, axis) : [], labelCount);
  }, [events, candles, axis, enabled, labelCount]);

  return null;
}

export const LiveWallSurgeMarkers = memo(LiveWallSurgeMarkersImpl);

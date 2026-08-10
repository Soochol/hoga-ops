import { memo, useEffect, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import { safeUnsubscribe } from './util/safeUnsubscribe';

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
};

/**
 * Vertical dashed line per Day Boundary (CONTEXT.md). Date labels are owned by
 * the adaptive x-axis (see util/kstHorzScaleBehavior) — this overlay draws only
 * the divider. The reposition handler coalesces
 * subscribeVisibleLogicalRangeChange + ResizeObserver events through
 * requestAnimationFrame and mutates only transform:translateX (GPU compositor
 * path, no layout thrash). plan-eng-review Perf #1.
 *
 * N segments → N-1 boundaries (no boundary at the start of segment[0]).
 */
function DayBoundaryOverlay({ chart, axis }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  const enabled = useActivePrefs((prefs) => prefs.dayBoundaryEnabled);
  const color = useActivePrefs((prefs) => prefs.dayBoundaryColor);
  const lineWidth = useActivePrefs((prefs) => prefs.dayBoundaryLineWidth);

  useEffect(() => {
    if (!enabled) return;

    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => force((n) => n + 1));
    };
    ts.subscribeVisibleLogicalRangeChange(schedule);
    const parent = containerRef.current?.parentElement;
    const ro =
      parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro && parent) ro.observe(parent);
    return () => {
      cancelAnimationFrame(raf);
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(schedule));
      ro?.disconnect();
    };
  }, [chart, enabled]);

  if (!enabled) return null;

  if (axis.segments.length < 2) return null;

  const ts = chart.timeScale();
  const boundaries = axis.dayBoundaries.map((b) => {
    const x = ts.timeToCoordinate((b.virtualStart / 1000) as UTCTimestamp);
    return { date: b.date, x };
  });

  // 컨테이너를 **pane 영역으로** 자른다. `inset-0` 로 두면 컨테이너가 차트 전체를
  // 덮는데(우측 가격축 거터 + 하단 시간축), 선의 x 는 `timeToCoordinate` 가 주는
  // **pane 좌표계** 값이다. 두 좌표계는 원점만 같고 **끝 경계가 다르다** — 그래서
  // x > paneWidth 인 경계선이 가격 라벨 배경 위에 그려졌고, 세로로는 선이 시간축의
  // 날짜 라벨을 관통했다. 캔버스는 z-index:1, 이 오버레이는 z-10 이라 덮는 쪽이 항상
  // 이긴다.
  //
  // 실측(/live, KOSPI 1분): 컨테이너 560.6×555.1px vs pane 498px 폭 / 시간축 28px.
  // 거터 62.6px 로 경계선이 4.9px 침범했다.
  //
  // 좌표를 클램프하지 않고 컨테이너를 자르는 이유는 걸친 선이 통째로 사라지지 않고
  // 잘린 만큼만 남기 위해서다. 배치는 여전히 transform:translateX 라 합성 경로도
  // 그대로다.
  //
  // 가격 자릿수가 바뀌어 거터 폭만 변하는 경우 ResizeObserver(부모 크기 불변)는 안
  // 걸리지만, 그 상황은 스크롤·줌·데이터 갱신과 동반되고 그쪽 rangeChange 가 재렌더를
  // 만들어 다음 프레임에 보정된다. 좌측 가격축은 이 리포에서 쓰지 않으므로(차트 옵션에
  // `rightPriceScale` 만 있다) pane 원점 = 컨테이너 left 0 이다.
  const paneWidth = ts.width();
  // 하단은 높이를 재지 않고 `bottom` 으로 민다 — 컨테이너 높이는 pane 개수·분할
  // 비율에 따라 바뀌지만 시간축 높이는 그와 무관하게 `ts.height()` 하나로 온다.
  const timeAxisHeight = ts.height();

  return (
    <div
      ref={containerRef}
      data-testid="day-boundary-clip"
      className="absolute top-0 left-0 overflow-hidden pointer-events-none z-10"
      style={{ width: `${paneWidth}px`, bottom: `${timeAxisHeight}px` }}
    >
      {boundaries.map((b) =>
        b.x == null ? null : (
          <div
            key={b.date}
            data-day-boundary={b.date}
            data-testid={`day-boundary-${b.date}`}
            className="absolute top-0 bottom-0"
            style={{
              width: `${lineWidth}px`,
              transform: `translateX(${b.x as number}px)`,
              backgroundImage: `repeating-linear-gradient(to bottom, ${color} 0 3px, transparent 3px 6px)`,
            }}
          />
        ),
      )}
    </div>
  );
}

// memo: depends only on chart + axis (both stable across SSE ticks on /live), so
// the parent's per-tick re-render no longer reaches this overlay (2026-06-09 Phase B).
export default memo(DayBoundaryOverlay);

/**
 * ⚠ PROTOTYPE — throwaway (studyDailyContextPrototype.ts 참조).
 *
 * 변형 A(밴드) / B(디밍)의 그리기 층. `chart/DayBoundaryOverlay` 의 패턴을 그대로
 * 베꼈다 — rAF 로 합친 `subscribeVisibleLogicalRangeChange` + `ResizeObserver`,
 * 그리고 **`z-10`**. lightweight-charts 는 캔버스를 `z-index:1` 에 그리므로
 * `z-0` 에 두면 캔버스 뒤로 들어가 우측 거터로만 새어 나온다(#1238 의 실패 모드).
 *
 * 좌표는 **저장 구간에 실제로 존재하는 캔들 ts** 로만 잡는다. D 는 캘린더 축이라
 * 하루가 1포인트고, 축에 없는 임의 ms 를 `toVirtual` 하면 좌표가 어긋난다.
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';
import { safeUnsubscribe } from '../../chart/util/safeUnsubscribe';
import type { StudySavedRangeMarks } from './studyDailyContextPrototype';

/** 차트 좌상단 레전드(OHLC 1줄 + 이동평균선 1줄)를 피하는 여유. 실측 후 상수. */
const LEGEND_CLEARANCE_PX = 46;

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  marks: StudySavedRangeMarks;
  mode: 'band' | 'dim';
};

function StudySavedRangeOverlay({ chart, axis, marks, mode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => force((n) => n + 1));
    };
    ts.subscribeVisibleLogicalRangeChange(schedule);
    const parent = containerRef.current?.parentElement;
    const ro = parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro && parent) ro.observe(parent);
    return () => {
      cancelAnimationFrame(raf);
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(schedule));
      ro?.disconnect();
    };
  }, [chart]);

  const ts = chart.timeScale();
  const half = Math.max(1, (ts.options().barSpacing ?? 6) / 2);
  const xFrom = ts.timeToCoordinate((axis.toVirtual(marks.fromMs) / 1000) as UTCTimestamp);
  const xTo = ts.timeToCoordinate((axis.toVirtual(marks.toMs) / 1000) as UTCTimestamp);
  if (xFrom == null || xTo == null) return null;
  const left = (xFrom as number) - half;
  const right = (xTo as number) + half;
  const width = Math.max(0, right - left);
  const plotWidth = ts.width();

  return (
    <div
      ref={containerRef}
      data-testid="study-saved-range-overlay"
      className="pointer-events-none absolute inset-0 z-10"
    >
      {mode === 'band' ? (
        <>
          <div
            className="absolute top-0 bottom-0"
            style={{ left: `${left}px`, width: `${width}px`, background: 'var(--tint-selection)' }}
          />
          <div
            className="absolute top-0 bottom-0"
            style={{ left: `${left}px`, width: '1px', background: 'var(--accent)' }}
          />
          <div
            className="absolute top-0 bottom-0"
            style={{ left: `${right}px`, width: '1px', background: 'var(--accent)' }}
          />
          <div
            className="absolute truncate rounded-sm px-1.5 py-0.5 text-[11px] tabular-nums"
            style={{
              // 레전드 2줄(시가/고가/저가/종가 + 이동평균선)을 피해 아래로 내린다.
              top: `${LEGEND_CLEARANCE_PX}px`,
              left: `${Math.max(2, left)}px`,
              maxWidth: `${Math.max(60, Math.min(width, plotWidth - Math.max(2, left)))}px`,
              background: 'var(--accent)',
              color: 'var(--bg)',
            }}
          >
            {marks.label}
          </div>
        </>
      ) : (
        <>
          <div
            className="absolute top-0 bottom-0 left-0"
            style={{ width: `${Math.max(0, left)}px`, background: 'var(--bg)', opacity: 0.62 }}
          />
          <div
            className="absolute top-0 bottom-0"
            style={{
              left: `${right}px`,
              width: `${Math.max(0, plotWidth - right)}px`,
              background: 'var(--bg)',
              opacity: 0.62,
            }}
          />
          <div
            className="absolute truncate text-[11px] tabular-nums"
            style={{ top: `${LEGEND_CLEARANCE_PX}px`, left: `${Math.max(4, left + 4)}px`, color: 'var(--fg-dim)' }}
          >
            {marks.label}
          </div>
        </>
      )}
    </div>
  );
}

export default memo(StudySavedRangeOverlay);

/**
 * `/study` 캘린더 봉에서 **저장 구간**을 표시하는 밴드.
 *
 * 넓힌 맥락 창(`studyDailyContext`) 안에서 "이 복기뷰가 저장한 구간이 어디인지" 를
 * 답하는 유일한 표시다. accent 계열 tint + 양끝 실선 + 상단 라벨.
 *
 * 구조는 `chart/DayBoundaryOverlay` 를 따른다 — rAF 로 합친
 * `subscribeVisibleLogicalRangeChange` + `ResizeObserver`, 그리고 **`z-10`**.
 * lightweight-charts 는 캔버스를 `z-index:1` 에 그리므로 `z-0` 에 두면 캔버스 뒤로
 * 들어가 우측 거터로만 새어 나온다(#1238 에서 실제로 그랬다).
 *
 * 좌표는 마크가 이미 캔들 ts 로 잡혀 있다(`studySavedRangeMarks` 주석 참조).
 * 여기서는 그 ts 를 축에 태우고 바 폭의 절반씩 바깥으로 넓혀 밴드 경계를 만든다.
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';
import type { StudySavedRangeMarks } from './studyDailyContext';

/** 차트 좌상단 레전드(OHLC 1줄 + 이동평균선 1줄) 아래로 라벨을 내리는 여유. */
const LEGEND_CLEARANCE_PX = 46;

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  marks: StudySavedRangeMarks;
};

function StudySavedRangeBand({ chart, axis, marks }: Props) {
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
  // 축이 아직 안 섰거나 구간이 통째로 화면 밖이면 lwc 가 null 을 준다 — 그리지 않는다.
  if (xFrom == null || xTo == null) return null;
  const left = (xFrom as number) - half;
  const right = (xTo as number) + half;
  const width = Math.max(0, right - left);
  const labelLeft = Math.max(2, left);

  return (
    <div
      ref={containerRef}
      data-testid="study-saved-range-band"
      className="pointer-events-none absolute inset-0 z-10"
    >
      <div
        data-testid="study-saved-range-fill"
        className="absolute top-0 bottom-0"
        style={{ left: `${left}px`, width: `${width}px`, background: 'var(--tint-selection)' }}
      />
      <div
        data-testid="study-saved-range-edge-from"
        className="absolute top-0 bottom-0 w-px"
        style={{ left: `${left}px`, background: 'var(--accent)' }}
      />
      <div
        data-testid="study-saved-range-edge-to"
        className="absolute top-0 bottom-0 w-px"
        style={{ left: `${right}px`, background: 'var(--accent)' }}
      />
      <div
        className="absolute truncate rounded-sm px-1.5 py-0.5 text-[11px] tabular-nums"
        style={{
          top: `${LEGEND_CLEARANCE_PX}px`,
          left: `${labelLeft}px`,
          maxWidth: `${Math.max(60, Math.min(width, ts.width() - labelLeft))}px`,
          background: 'var(--accent)',
          color: 'var(--bg)',
        }}
      >
        {marks.label}
      </div>
    </div>
  );
}

export default memo(StudySavedRangeBand);

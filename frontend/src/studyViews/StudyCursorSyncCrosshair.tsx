/**
 * `/study` 일봉 창에 **다른 창(분봉)의 마우스 위치**를 크로스헤어로 표시한다.
 *
 * 선은 직접 그리지 않는다 — lightweight-charts 가 "두 차트의 크로스헤어 동기화"
 * 용도로 문서화한 `setCrosshairPosition` 을 부른다(`typings.d.ts` 의 예시가 곧 이
 * 기능이다). 그래서 세로선·가로선뿐 아니라 **시간축 날짜 배지와 가격축 값 배지가
 * 함께 붙는다** — 손으로 그리면 그 셋을 각각 만들어야 하고, 그 과정에서 이 리포가
 * 이미 두 번 밟은 오버레이 함정(캔버스 뒤로 숨음 #1238 / 축 거터를 덮음 #1272)을
 * 다시 풀어야 한다.
 *
 * DOM 으로 남는 것은 둘뿐이고, 둘 다 lwc 가 채울 수 없는 자리다:
 *  - **시각 칩** — 시간축 배지는 일봉 축이라 날짜까지다. 분봉 커서의 시:분은 그
 *    축에 표현될 자리가 없다.
 *  - **엣지 인디케이터** — 두 창의 뷰포트가 독립이라 대상 캔들이 화면 밖인 경우가
 *    흔하다(실측: pane 왼쪽 1,236px 밖). lwc 는 그때 아무것도 그리지 않는데, 그러면
 *    "동기화가 고장났다" 로 읽힌다. 방향과 날짜만 가장자리에 남긴다.
 *
 * 좌표·필터 판정은 `studyCursorSync.ts` 가 소유한다. 여기서는 그 결과를 축에 태우고
 * 그린다.
 *
 * 실측으로 확인한 성질 하나: `setCrosshairPosition` 은 그 차트의
 * `subscribeCrosshairMove` 를 **발화시키지 않는다.** 그래서 일봉 창의 레전드·툴팁은
 * 반응하지 않고(의도), 사이드바 커서를 오염시키거나 발행↔소비 피드백 루프를 만들지도
 * 않는다. 레전드까지 연동하려면 별도 경로가 필요하다 — 지금 범위 밖이다.
 */
import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { WindowViewContext } from '../live/workspace/windowView';
import type { VirtualAxis } from '../util/virtualAxis';
import {
  formatKstHhmm,
  formatKstMmdd,
  indexCandlesByKstDate,
  resolveSyncTarget,
  type SyncCandle,
} from './studyCursorSync';

/** 좌상단 레전드(OHLC + 이동평균)와 저장 구간 라벨이 쓰는 높이. */
const LEGEND_CLEARANCE_PX = 46;
/** 저장 구간 라벨과 같은 y 를 피해 한 줄 더 내린다(둘 다 accent 칩이라 붙으면 읽히지 않는다). */
const CHIP_TOP_PX = LEGEND_CLEARANCE_PX + 24;
/** 칩이 pane 가장자리에서 잘리지 않게 두는 여백. */
const CHIP_EDGE_MARGIN_PX = 26;

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  /** 이 창이 그리고 있는 일봉 캔들. */
  candles: readonly SyncCandle[];
  /** `setCrosshairPosition` 이 시리즈 핸들을 요구한다. */
  paneSeries: PaneSeriesMap;
  /** 이 창의 종목 — 발행 origin 과 대조한다. */
  code: string | null;
};

const chipStyle = { background: 'var(--accent)', color: 'var(--accent-fg)' } as const;

function StudyCursorSyncCrosshair({ chart, axis, candles, paneSeries, code }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  const syncCursorMs = useLiveCursorStore((s) => s.syncCursorMs);
  const syncCursorOrigin = useLiveCursorStore((s) => s.syncCursorOrigin);
  const myWindowId = useContext(WindowViewContext)?.windowId ?? null;

  // 축이 움직이면 칩 좌표를 다시 잡는다. `StudySavedRangeBand` 와 같은 패턴
  // (rAF 로 합친 visible-range 구독 + `ResizeObserver`).
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

  const byDate = useMemo(() => indexCandlesByKstDate(candles), [candles]);

  const target = useMemo(
    () => resolveSyncTarget({
      cursor: syncCursorMs !== null && syncCursorOrigin !== null
        ? { tsMs: syncCursorMs, origin: syncCursorOrigin }
        : null,
      myWindowId,
      myCode: code,
      byDate,
    }),
    [syncCursorMs, syncCursorOrigin, myWindowId, code, byDate],
  );

  // 크로스헤어 자체. cleanup 이 이전 위치를 지우므로 커서가 바뀌면 옮겨 가고,
  // 발행이 끊기거나(포인터가 분봉 창을 벗어남) 언마운트되면 사라진다.
  useEffect(() => {
    const series = paneSeries.get('candle');
    if (!series || !target) return;
    chart.setCrosshairPosition(
      target.close,
      (axis.toVirtual(target.ts_ms) / 1000) as UTCTimestamp,
      series,
    );
    return () => { chart.clearCrosshairPosition(); };
  }, [target, chart, axis, paneSeries]);

  if (!target || syncCursorMs === null) return null;

  const ts = chart.timeScale();
  const x = ts.timeToCoordinate((axis.toVirtual(target.ts_ms) / 1000) as UTCTimestamp);
  // 축이 아직 안 섰다 — lwc 도 크로스헤어를 못 그렸을 테니 칩만 생략한다.
  if (x == null) return null;

  const paneWidth = ts.width();
  const cx = x as number;
  const clock = formatKstHhmm(syncCursorMs);

  return (
    <div
      ref={containerRef}
      data-testid="study-cursor-sync"
      // pane 박스로 클립한다. `inset-0` 이면 컨테이너가 우측 가격축 거터 + 하단
      // 시간축까지 덮는데, `timeToCoordinate` 가 주는 건 **pane 좌표**라 두 좌표계의
      // 끝 경계가 다르다 — 칩이 축 라벨 위로 새어 나온다(#1272 와 같은 사고).
      className="pointer-events-none absolute top-0 left-0 z-10 overflow-hidden"
      style={{ width: `${paneWidth}px`, bottom: `${ts.height()}px` }}
    >
      {cx < 0 || cx > paneWidth ? (
        <EdgeIndicator
          side={cx < 0 ? 'left' : 'right'}
          date={formatKstMmdd(syncCursorMs)}
          clock={clock}
        />
      ) : (
        <div
          data-testid="study-cursor-sync-chip"
          className="absolute -translate-x-1/2 rounded-sm px-1.5 py-0.5 text-[11px] tabular-nums"
          style={{
            ...chipStyle,
            top: `${CHIP_TOP_PX}px`,
            left: `${Math.min(
              Math.max(cx, CHIP_EDGE_MARGIN_PX),
              Math.max(CHIP_EDGE_MARGIN_PX, paneWidth - CHIP_EDGE_MARGIN_PX),
            )}px`,
          }}
        >
          {clock}
        </div>
      )}
    </div>
  );
}

function EdgeIndicator({
  side, date, clock,
}: { side: 'left' | 'right'; date: string; clock: string }) {
  return (
    <div
      data-testid={`study-cursor-sync-edge-${side}`}
      className="absolute flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] tabular-nums"
      style={{ ...chipStyle, top: `${CHIP_TOP_PX}px`, [side]: '4px' }}
    >
      {side === 'left' && <span aria-hidden>◀</span>}
      <span>{date} {clock}</span>
      {side === 'right' && <span aria-hidden>▶</span>}
    </div>
  );
}

export default memo(StudyCursorSyncCrosshair);

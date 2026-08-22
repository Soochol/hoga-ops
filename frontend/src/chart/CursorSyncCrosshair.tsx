/**
 * **다른 창의 마우스 위치**를 이 창의 크로스헤어로 표시한다. `/study` 와 `/live`
 * 워크스페이스가 둘 다 쓰고, 동작은 페이지에 무관하다.
 *
 * 방향은 넷이다 — 분봉→일봉 · 일봉→일봉 · 분봉→분봉 · 일봉→분봉. 대상을 어떻게
 * 찾는지는 **이 창의 봉**과 **발행 봉**이 함께 정하고, 그 판정은 전부 `cursorSync.ts`
 * 가 갖는다. 여기서 하는 일은 자기 봉으로 다리(`SyncTargetSource`)를 고르고 판정
 * 결과 세 갈래(`SyncResolution`)를 각각 그리는 것뿐이다.
 *
 * 선은 직접 그리지 않는다 — lightweight-charts 가 "두 차트의 크로스헤어 동기화"
 * 용도로 문서화한 `setCrosshairPosition` 을 부른다(`typings.d.ts` 의 예시가 곧 이
 * 기능이다). 그래서 세로선·가로선뿐 아니라 **시간축 날짜 배지와 가격축 값 배지가
 * 함께 붙는다** — 손으로 그리면 그 셋을 각각 만들어야 하고, 그 과정에서 이 리포가
 * 이미 두 번 밟은 오버레이 함정(캔버스 뒤로 숨음 #1238 / 축 거터를 덮음 #1272)을
 * 다시 풀어야 한다.
 *
 * DOM 으로 남는 것은 **엣지 인디케이터 하나뿐**이다. 두 창의 뷰포트가 독립이라 대상
 * 캔들이 화면 밖인 경우가 흔한데(실측: pane 왼쪽 1,236px 밖) lwc 는 그때 아무것도
 * 그리지 않아 "동기화가 고장났다" 로 읽힌다. 방향과 **날짜만** 가장자리에 남긴다.
 *
 * 같은 칩이 **대상이 아예 없을 때도** 뜬다(`out-of-range`) — 그 날이 이 창의 로드
 * 범위 밖인 경우다. 일봉→분봉에서 이건 예외가 아니라 **다수**다: 일봉 창은 수개월을
 * 보여주는데 분봉 창은 보통 1~2일치만 들고 있다. 두 경우의 차이는 크로스헤어를
 * 거는가뿐이고(범위 밖이면 안 건다) 칩은 같은 말을 한다 — "그 날은 저쪽이다".
 *
 * **분봉의 시:분은 일봉 창에 표시하지 않는다**(사용자 결정, 2026-08-11). 초기 판에는
 * 크로스헤어 위에 시각 칩(`14:09`)이 있었다 — lwc 시간축 배지가 일봉 축이라 날짜까지만
 * 찍는 것을 보완하려던 것이다. 일봉 차트에 분 단위 시각이 뜨는 것이 축과 맞지 않아
 * 걷어냈고, 같은 이유로 엣지 인디케이터에서도 시각을 뺐다.
 *
 * 좌표·필터 판정은 `cursorSync.ts` 가 소유한다. 여기서는 그 결과를 축에 태우고
 * 그린다. **종목 범위만 이 컴포넌트가 실어 준다** — ⚙️ 설정 → 차트의
 * `cursorSyncCrossSymbol`(기본 켬)을 읽어 `allowCrossSymbol` 로 넘긴다. 끄면
 * 같은 종목 창끼리만 동기화하던 2026-08-11 동작으로 돌아간다(방향과 무관하게 일괄).
 *
 * 실측으로 확인한 성질 하나: `setCrosshairPosition` 은 그 차트의
 * `subscribeCrosshairMove` 를 **발화시키지 않는다.** 그래서 일봉 창의 레전드·툴팁은
 * 반응하지 않고(의도), 사이드바 커서를 오염시키거나 발행↔소비 피드백 루프를 만들지도
 * 않는다. 레전드까지 연동하려면 별도 경로가 필요하다 — 지금 범위 밖이다.
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import type { PaneSeriesMap } from './drawing/chartCoordinates';
import { safeUnsubscribe } from './util/safeUnsubscribe';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import type { VirtualAxis } from '../util/virtualAxis';
import { formatKstMmdd, type SyncCandle } from './cursorSync';
import { useCursorSyncResolution } from '../live/useCursorSyncResolution';
import type { LiveTimeframe } from '../state/livePage';

/** 좌상단 레전드(OHLC + 이동평균)와 저장 구간 라벨이 쓰는 높이. */
const LEGEND_CLEARANCE_PX = 46;
/** 저장 구간 라벨과 같은 y 를 피해 한 줄 더 내린다(둘 다 accent 칩이라 붙으면 읽히지 않는다). */
const EDGE_TOP_PX = LEGEND_CLEARANCE_PX + 24;

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  /** 이 창이 그리고 있는 캔들. **ts 오름차순**이어야 한다(분봉 다리가 이진 탐색). */
  candles: readonly SyncCandle[];
  /** 이 창의 봉 — 다리와 받아 주는 발행 집합을 이것이 정한다. */
  timeframe: LiveTimeframe;
  /** `setCrosshairPosition` 이 시리즈 핸들을 요구한다. */
  paneSeries: PaneSeriesMap;
  /** 이 창의 종목 — 발행 origin 과 대조한다. */
  code: string | null;
};

const chipStyle = { background: 'var(--accent)', color: 'var(--accent-fg)' } as const;

function CursorSyncCrosshair({ chart, axis, candles, timeframe, paneSeries, code }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  const syncCursorMs = useLiveCursorStore((s) => s.syncCursorMs);
  // 판정은 **레전드와 공유한다** — 각자 하면 게이트가 갈려 "선은 여기, 숫자는 저기"
  // 가 된다(`useCursorSyncResolution` 헤더).
  const resolution = useCursorSyncResolution({ candles, timeframe, code });
  const target = resolution.kind === 'hit' ? resolution.candle : null;

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


  // 크로스헤어 자체. cleanup 이 이전 위치를 지우므로 커서가 바뀌면 옮겨 가고,
  // 발행이 끊기거나(포인터가 발행 창을 벗어남) 언마운트되면 사라진다.
  // **`out-of-range` 에는 걸지 않는다** — 가리킬 캔들이 이 창에 없다.
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

  if (resolution.kind === 'none' || syncCursorMs === null) return null;

  const ts = chart.timeScale();
  const paneWidth = ts.width();
  // 칩을 띄우는 사유가 둘이다:
  //  - `out-of-range`: 그 날이 이 창에 아예 없다. 판정이 방향을 이미 알고 있다.
  //  - `hit` 인데 화면 밖: 캔들은 있는데 뷰포트 밖이다(실측 pane 왼쪽 1,236px 밖).
  //    lwc 는 그때 아무것도 그리지 않아 "동기화가 고장났다" 로 읽힌다.
  // 축이 아직 안 섰으면(`timeToCoordinate` 가 null) 화면 안팎을 모르니 칩도 없다.
  const x = target
    ? ts.timeToCoordinate((axis.toVirtual(target.ts_ms) / 1000) as UTCTimestamp)
    : null;
  const edgeSide: 'left' | 'right' | null = resolution.kind === 'out-of-range'
    ? resolution.side
    : (x != null && ((x as number) < 0 || (x as number) > paneWidth)
      ? ((x as number) < 0 ? 'left' : 'right')
      : null);

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
      {edgeSide && (
        <EdgeIndicator side={edgeSide} date={formatKstMmdd(syncCursorMs)} />
      )}
    </div>
  );
}

function EdgeIndicator({ side, date }: { side: 'left' | 'right'; date: string }) {
  return (
    <div
      data-testid={`study-cursor-sync-edge-${side}`}
      className="absolute flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] tabular-nums"
      style={{ ...chipStyle, top: `${EDGE_TOP_PX}px`, [side]: '4px' }}
    >
      {side === 'left' && <span aria-hidden>◀</span>}
      <span>{date}</span>
      {side === 'right' && <span aria-hidden>▶</span>}
    </div>
  );
}

export default memo(CursorSyncCrosshair);

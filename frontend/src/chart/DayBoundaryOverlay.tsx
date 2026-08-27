import { memo, useEffect, useRef } from 'react';
import type { DayBoundaryTick } from './sessionSpans';
import type { PaneSeriesMap } from './drawing/chartCoordinates';
import { useActivePrefs } from '../state/chartPrefs';
import { DayBoundaryPrimitive, type DayBoundarySnapshot } from './DayBoundaryPrimitive';

type Props = {
  /**
   * 차트의 pane 별 시리즈. **모든 pane 에 하나씩** primitive 를 붙이기 위해 필요하다
   * (아래 docstring 참조).
   */
  paneSeries: PaneSeriesMap;
  /**
   * 경계가 설 자리 — `resolveDayBoundaryTicks` 가 만든다. **개장 정각이 아니라 그
   * 세션에서 실제로 렌더되는 첫 캔들의 시각**이어야 하는 이유는 그 모듈의 docstring
   * 참조(요약: lwc 의 `timeToCoordinate` 는 보간이 아니라 조회라, 축에 없는 시각은
   * `null` 을 주고 선이 조용히 사라진다).
   */
  boundaries: readonly DayBoundaryTick[];
};

/**
 * 세션 경계 세로 점선의 **primitive 호스트** — 이름은 `Overlay` 지만 DOM 을 하나도
 * 그리지 않는다(반환값은 `null`). 그리기는 `DayBoundaryPrimitive` 가 lwc 캔버스
 * 패스에서 하고, 이 컴포넌트는 매 프레임 draw 가 pull 할 스냅샷만 갱신한다.
 * 이름을 유지하는 이유는 `sessionSpans.ts` · `PaneLegendOverlay` · `auctionHide.ts`
 * 의 주석이 이 이름으로 이 표시를 가리키기 때문이다.
 *
 * **여기엔 range 구독이 없다 — 그게 요점이다.** 옛 구현은
 * `subscribeVisibleLogicalRangeChange` → rAF → `setState` → React 렌더 → DOM 커밋
 * 경로로 `transform:translateX` 를 갱신했고, 그 경로는 캔들 캔버스보다 최소 한
 * 프레임 늦어 **팬/줌 중 구분선이 캔들을 뒤따라왔다**(사용자 신고 2026-08-27).
 * 팬/줌 재계산은 이제 lwc 가 캔들과 같은 프레임에 하고, `requestUpdate` 는 오직
 * 데이터·스타일이 바뀌었을 때만 부른다. 구독을 하나라도 되살리면 지연도 돌아온다.
 *
 * **모든 pane 에 하나씩 붙인다.** primitive 는 자기가 달린 pane 캔버스에만 그리는데,
 * 옛 DOM 오버레이는 차트 전체 높이(시간축만 제외)를 덮어 거래량·보조지표 pane 까지
 * 선이 이어졌다. 캔들 pane 에만 붙이면 선이 캔들 pane 바닥에서 끊겨 **시각 회귀**가
 * 된다(`StudySavedRangeBandHost` 와 같은 판단).
 *
 * N 세그먼트 → N-1 경계(첫 세그먼트 앞에는 긋지 않는다).
 */
function DayBoundaryOverlay({ paneSeries, boundaries }: Props) {
  const enabled = useActivePrefs((prefs) => prefs.dayBoundaryEnabled);
  const color = useActivePrefs((prefs) => prefs.dayBoundaryColor);
  const lineWidth = useActivePrefs((prefs) => prefs.dayBoundaryLineWidth);

  const snapshotRef = useRef<DayBoundarySnapshot | null>(null);
  const primsRef = useRef<DayBoundaryPrimitive[]>([]);

  // 스냅샷 갱신은 **아래 attach effect 보다 먼저** 돌아야 첫 프레임이 빈 그림이 되지
  // 않는다(React 는 effect 를 선언 순서로 실행한다). 담기는 건 좌표가 아니라 시각·
  // 스타일이라, 팬/줌은 여기 deps 를 건드리지 않는다 — 그래서 이 effect 는 데이터가
  // 실제로 바뀔 때만 돈다.
  //
  // `boundaries` 는 호출부가 값이 같으면 이전 참조를 유지하도록 안정화한다
  // (`sameDayBoundaryTicks`) — 그 전제가 깨지면 SSE 틱마다 헛된 repaint 를 부른다.
  useEffect(() => {
    snapshotRef.current = { boundaries, color, lineWidth };
    for (const prim of primsRef.current) prim.requestUpdate();
  }, [boundaries, color, lineWidth]);

  useEffect(() => {
    if (!enabled) return;

    const attached = [...paneSeries.values()].map((series) => {
      const prim = new DayBoundaryPrimitive(() => snapshotRef.current);
      series.attachPrimitive(prim);
      prim.requestUpdate();
      return { series, prim };
    });
    primsRef.current = attached.map((a) => a.prim);
    return () => {
      for (const { series, prim } of attached) {
        try {
          series.detachPrimitive(prim);
        } catch {
          /* chart already torn down */
        }
      }
      primsRef.current = [];
    };
  }, [paneSeries, enabled]);

  return null;
}

// memo: 입력은 paneSeries + boundaries 뿐이고 둘 다 호출부가 안정화한다.
export default memo(DayBoundaryOverlay);

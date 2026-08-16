import { memo, useEffect, useRef } from 'react';
import type { VirtualAxis } from '../util/virtualAxis';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import {
  StudySavedRangeBandPrimitive,
  type StudySavedRangeBandSnapshot,
} from '../chart/StudySavedRangeBandPrimitive';
import type { StudySavedRangeMarks } from './studyDailyContext';

type Props = {
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
  marks: StudySavedRangeMarks;
};

/**
 * `/study` 저장 구간 밴드의 primitive 호스트 — DOM 을 그리지 않고 series 에
 * `StudySavedRangeBandPrimitive` 를 붙인 뒤 매 프레임 draw 가 pull 할 스냅샷만
 * 갱신한다. 팬/줌 재계산은 lwc 의 캔버스 패스가 담당하므로 여기엔 range 구독이
 * 없다(그게 옛 DOM 오버레이의 한 프레임 지연 원인이었다 — `HighLowLabelsHost` 선례).
 *
 * **모든 pane 에 하나씩 붙인다.** primitive 는 자기가 달린 pane 캔버스에만 그리는데,
 * 옛 DOM 오버레이는 차트 전체 높이를 덮어 거래량·보조지표 pane 까지 밴드가 이어졌다.
 * 캔들 pane 에만 붙이면 밴드가 캔들 pane 바닥에서 끊겨 **시각 회귀**가 된다.
 */
function StudySavedRangeBandHost({ axis, paneSeries, marks }: Props) {
  const snapshotRef = useRef<StudySavedRangeBandSnapshot | null>(null);
  const primsRef = useRef<StudySavedRangeBandPrimitive[]>([]);

  // 스냅샷은 커밋 후 갱신하고 repaint 를 요청한다. 팬/줌은 요청 없이도 lwc 가 그리므로
  // 여기 deps 는 순수 데이터 변화만 커버하면 된다.
  //
  // deps 를 `marks` 객체가 아니라 **필드 값**으로 잡는다 — 생산부(`StudyPage`)가 매
  // 렌더 `studySavedRangeMarks()` 를 새로 호출해 식별자가 churn 하므로, 객체로 잡으면
  // 값이 그대로인데도 렌더마다 repaint 를 요청하게 된다.
  const { fromMs, toMs, barCount } = marks;
  useEffect(() => {
    snapshotRef.current = { axis, marks: { fromMs, toMs, barCount } };
    for (const prim of primsRef.current) prim.requestUpdate();
  }, [axis, fromMs, toMs, barCount]);

  useEffect(() => {
    const attached = [...paneSeries.values()].map((series) => {
      const prim = new StudySavedRangeBandPrimitive(() => snapshotRef.current);
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
  }, [paneSeries]);

  return null;
}

export default memo(StudySavedRangeBandHost);

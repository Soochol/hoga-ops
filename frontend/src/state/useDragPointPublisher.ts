import { useCallback, useEffect, useRef } from 'react';
import { isPointOnChart, useEntryDragStore } from './entryDrag';

/**
 * 드래그 좌표를 `entryDrag` store 에 **프레임당 한 번만** 발행하는 rAF 스로틀.
 *
 * dnd-kit 의 `onDragMove` 는 pointermove 마다 불린다. 거기서 곧장 `setDragPoint` 를
 * 치면 WorkspaceCanvas 가 포인터 이동마다 리렌더되고, 그 안의 `api.boxRect()`
 * (`getBoundingClientRect`)가 매번 강제 레이아웃을 유발한다. 좌표는 ref 에 적고
 * 프레임 경계에서 한 번만 내보낸다.
 *
 * 우측 레일의 네 드로어(관심종목·스크리너·순위·히트맵)가 같은 seam 을 쓰므로 여기 한 곳에
 * 둔다 — 특히 **취소 규율**이 중요하다: 예약된 프레임이 `endDrag` 뒤에 실행되면 방금
 * 지운 dragPoint 가 되살아나 캔버스 드롭 어포던스가 화면에 남는다. 언마운트 정리도
 * 같은 이유다.
 */
export function useDragPointPublisher() {
  const setOverChart = useEntryDragStore((s) => s.setOverChart);
  const setDragPoint = useEntryDragStore((s) => s.setDragPoint);
  const pendingPointRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    rafRef.current = null;
    const point = pendingPointRef.current;
    setOverChart(isPointOnChart(point));
    setDragPoint(point);
  }, [setOverChart, setDragPoint]);

  /** onDragMove 에서 호출 — 좌표를 적어 두고 프레임 하나를 예약한다(이미 있으면 재사용). */
  const publishDragPoint = useCallback((point: { x: number; y: number } | null) => {
    pendingPointRef.current = point;
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
  }, [flush]);

  /** 드래그 종료·취소에서 호출 — 예약된 프레임을 버린다(위 주석의 되살아남 방지). */
  const cancelDragPointFlush = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    pendingPointRef.current = null;
  }, []);

  useEffect(() => cancelDragPointFlush, [cancelDragPointFlush]);

  return { publishDragPoint, cancelDragPointFlush };
}

import { useCallback, useState } from 'react';
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core';
import { dropPoint, isPointOnChart, resolveDropOnChart, useEntryDragStore } from '../state/entryDrag';
import { useDragPointPublisher } from '../state/useDragPointPublisher';

/** 고스트에 그릴 스냅샷. drag start 에 한 번 찍고 드래그 내내 갱신하지 않는다 —
 *  손에 든 것이 도중에 바뀌면 산만하고, 데이터 동결과도 같은 규율이다.
 *
 *  `rank` 는 순위 드로어 전용이라 optional 이다(스크리너 행엔 순위 개념이 없다).
 *  고스트는 **자기 리스트 행의 렌더를 복제**하는 것이 계약이므로, leading 슬롯을
 *  가진 리스트는 그 슬롯의 내용까지 스냅샷에 담아야 손에 든 것이 어긋나지 않는다. */
export type ChartDropGhost = {
  code: string; name: string; price: number | null; pct: number | null;
  rank?: number;
};

/**
 * "행을 끌어 차트 창에 떨군다" 제스처의 공용 배선 — 스크리너·순위 드로어가 공유한다.
 *
 * 두 패널의 드래그는 **재정렬이 아니라 복사 제스처**다: droppable 이 없어 `over` 자체가
 * 없고, 드롭 후에도 행은 리스트에 남는다. 그래서 관심종목과 달리 충돌 억제(over 를
 * 비우는 처방)도, 원본 행을 빈 자리로 만드는 placeholder 도 여기엔 해당이 없다.
 *
 * **왜 훅 하나로 묶는가**: `onDragEnd` 의 순서 계약이 미묘하기 때문이다 — 낙하 애니메이션
 * 판정을 `endDrag()` **전에** 캡처해야 한다(안 그러면 차트 드롭에서도 고스트가 패널로
 * 되날아간다). 두 드로어에 손으로 두 번 옮겨 적으면 한쪽에서 틀린다.
 *
 * @param entryType 이 드로어의 `active.data.current.type` 태그
 * @param onFallbackPick 좌표 아래 창이 없을 때(캔버스 여백) 활성 그룹 종목 교체
 */
export function useChartDropDrag(
  entryType: string,
  onFallbackPick: (code: string, name?: string) => void,
) {
  const startEntryDrag = useEntryDragStore((s) => s.startDrag);
  const endEntryDrag = useEntryDragStore((s) => s.endDrag);
  const { publishDragPoint, cancelDragPointFlush } = useDragPointPublisher();

  /** 드래그 진행 중 여부 — 호출부가 데이터 동결(useFrozenWhileDragging)에 쓴다. */
  const [isDragging, setIsDragging] = useState(false);
  const [ghost, setGhost] = useState<ChartDropGhost | null>(null);
  /** 직전 드롭이 차트 위였는가(낙하 애니메이션 결정). 취소는 false 로 남긴다 —
   *  취소는 원위치로 돌아가는 게 맞다. */
  const [droppedOnChart, setDroppedOnChart] = useState(false);

  const finish = useCallback(() => {
    cancelDragPointFlush();
    setIsDragging(false);
    setGhost(null);
    endEntryDrag();
  }, [cancelDragPointFlush, endEntryDrag]);

  const onDragStart = useCallback((ev: DragStartEvent, snapshot: ChartDropGhost | null) => {
    if (ev.active.data.current?.type !== entryType) return;
    const code = String((ev.active.data.current as { code?: string }).code ?? '');
    if (!code) return;
    setIsDragging(true);
    setDroppedOnChart(false);   // 직전 드래그의 판정이 새 드래그로 새지 않게
    setGhost(snapshot);
    startEntryDrag(code);
  }, [entryType, startEntryDrag]);

  const onDragMove = useCallback((ev: DragMoveEvent) => {
    if (ev.active.data.current?.type !== entryType) return;
    publishDragPoint(dropPoint(ev));   // 창별 어포던스: 캔버스가 좌표로 호버 창을 계산한다
  }, [entryType, publishDragPoint]);

  const onDragCancel = useCallback(() => finish(), [finish]);

  const onDragEnd = useCallback((ev: DragEndEvent) => {
    const wasEntry = ev.active.data.current?.type === entryType;
    const onChart = wasEntry && isPointOnChart(dropPoint(ev));
    // **지우기 전에** 확정한다 — finish() 안의 endEntryDrag() 가 store 의 overChart 를
    // 되돌리고 그 갱신은 dnd-kit 의 active→null 과 같은 커밋에 착지한다. 판정식은 아래
    // 드롭 분기와 같은 술어라 둘이 갈릴 수 없다.
    setDroppedOnChart(onChart);
    finish();
    if (!onChart) return;
    const d = ev.active.data.current as { code?: string; name?: string } | undefined;
    if (!d?.code) return;
    // 창 위 드롭 = 그 창 그룹 종목 교체(정밀 드롭, #711), 창 밖 = 활성 그룹 교체.
    if (resolveDropOnChart(dropPoint(ev), { code: d.code, name: d.name })) return;
    onFallbackPick(d.code, d.name);
  }, [entryType, finish, onFallbackPick]);

  return { isDragging, ghost, droppedOnChart, onDragStart, onDragMove, onDragEnd, onDragCancel };
}

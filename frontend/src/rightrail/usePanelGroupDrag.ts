import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { SortingStrategy } from '@dnd-kit/sortable';
import type { RailDragOverlayRect } from './RailDragOverlay';

export type PanelGroupDrop = {
  folderId: string;
  side: 'before' | 'after';
  orderedIds: string[];
};

// 헤더 슬롯은 고정하고 삽입선으로만 이동 위치를 보여 준다. 정렬 transform으로 슬롯을
// 움직이면 커서 아래 타깃도 바뀌어, 시작 위치 유지와 빈 공간 취소 판정이 흔들린다.
export const keepPanelGroupSlots: SortingStrategy = () => null;

export function resolvePanelGroupDrop(
  panel: HTMLElement | null,
  orderedIds: string[],
  activeId: string,
  point: { x: number; y: number } | null,
): PanelGroupDrop | null {
  if (!panel || !point || !orderedIds.includes(activeId)) return null;
  const contains = (r: DOMRect) => point.x >= r.left && point.x < r.right && point.y >= r.top && point.y < r.bottom;
  if (!contains(panel.getBoundingClientRect())) return null;
  for (const header of panel.querySelectorAll<HTMLElement>('[data-panel-group-id]')) {
    const folderId = header.dataset.panelGroupId!;
    if (!orderedIds.includes(folderId)) continue;
    const rect = header.getBoundingClientRect();
    if (!contains(rect)) continue;
    if (folderId === activeId) return null;
    const side = point.y > rect.top + rect.height / 2 ? 'after' : 'before';
    const next = orderedIds.filter((id) => id !== activeId);
    next.splice(next.indexOf(folderId) + (side === 'after' ? 1 : 0), 0, activeId);
    if (next.every((id, index) => id === orderedIds[index])) return null;
    return { folderId, side, orderedIds: next };
  }
  return null;
}

/** 접힌 목록의 원래 슬롯을 잡은 높이에 맞추고, 종료 후 스크롤을 복원한다. */
export function usePanelGroupDrag(scrollRef: RefObject<HTMLElement | null>) {
  const [layout, setLayout] = useState<{ paddingTop: number; minHeight: number; scrollTop: number } | null>(null);
  const restoreScroll = useRef<number | null>(null);
  const [target, setTarget] = useState<PanelGroupDrop | null>(null);
  const start = useCallback((folderId: string, rect: RailDragOverlayRect | undefined) => {
    const panel = scrollRef.current;
    if (!panel || !rect) return;
    const headers = [...panel.querySelectorAll<HTMLElement>('[data-panel-group-id]')];
    const index = headers.findIndex((header) => header.dataset.panelGroupId === folderId);
    if (index < 0) return;
    const prefixHeight = headers.slice(0, index).reduce((sum, header) => sum + header.getBoundingClientRect().height, 0);
    const top = rect.top - panel.getBoundingClientRect().top;
    const scrollTop = Math.max(0, prefixHeight - top);
    restoreScroll.current = panel.scrollTop;
    setLayout({ paddingTop: Math.max(0, top - prefixHeight), minHeight: scrollTop + panel.clientHeight, scrollTop });
    setTarget(null);
  }, [scrollRef]);
  useLayoutEffect(() => {
    const panel = scrollRef.current;
    if (!panel) return;
    if (layout) panel.scrollTop = layout.scrollTop;
    else if (restoreScroll.current !== null) {
      panel.scrollTop = restoreScroll.current;
      restoreScroll.current = null;
    }
  }, [layout, scrollRef]);
  const resolve = useCallback((ids: string[], activeId: string, point: { x: number; y: number } | null) =>
    resolvePanelGroupDrop(scrollRef.current, ids, activeId, point), [scrollRef]);
  const update = useCallback((ids: string[], activeId: string, point: { x: number; y: number } | null) => {
    const next = resolve(ids, activeId, point);
    setTarget((old) => old?.folderId === next?.folderId && old?.side === next?.side ? old : next);
  }, [resolve]);
  const finish = useCallback(() => { setLayout(null); setTarget(null); }, []);
  return {
    start, finish, update, resolve, target,
    style: layout ? { paddingTop: layout.paddingTop, minHeight: layout.minHeight, overflowAnchor: 'none' as const } : undefined,
  };
}

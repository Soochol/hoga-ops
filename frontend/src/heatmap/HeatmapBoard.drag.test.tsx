import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// dnd-kit passthrough — 주입된 onDragStart/onDragEnd 를 캡처한다(실제 포인터/충돌은
// e2e 담당, 여기선 wiring contract 만). useDraggable/useSortable/useDroppable 은 no-op.
const h = vi.hoisted(() => ({
  onDragStart: null as null | ((e: unknown) => void),
  onDragEnd: null as null | ((e: unknown) => void),
}));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragStart, onDragEnd }: {
      children: ReactNode;
      onDragStart: (e: unknown) => void;
      onDragEnd: (e: unknown) => void;
    }) => {
      h.onDragStart = onDragStart;
      h.onDragEnd = onDragEnd;
      return <>{children}</>;
    },
    useSensor: () => ({}),
    useSensors: () => [],
    PointerSensor: class {},
    useDraggable: () => ({ setNodeRef: () => {}, listeners: {}, attributes: {}, transform: null, isDragging: false }),
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  };
});
vi.mock('@dnd-kit/sortable', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
    useSortable: () => ({
      setNodeRef: () => {}, listeners: {}, attributes: {},
      transform: null, transition: undefined, isDragging: false,
    }),
  };
});
vi.mock('./FolderAddButton', () => ({ FolderAddButton: () => null }));

import { HeatmapBoard } from './HeatmapBoard';
import type { HeatmapGroup } from './heat';
import type { LiveQuote } from '../api/liveQuotes';

const groups: HeatmapGroup[] = [
  { folder: { id: 'f1', name: '반도체', order: 0 }, entries: [
    { code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 },
    { code: '000660', name: 'SK하이닉스', folder_id: 'f1', order: 1 },
  ] },
  { folder: { id: 'f2', name: '대형주', order: 1 }, entries: [
    { code: '373220', name: 'LG에너지', folder_id: 'f2', order: 0 },
  ] },
];

/** 다른 그룹 블록(entry-target) 위에 드롭. */
const toGroup = (code: string, name: string, from: string, to: string, ctrl: boolean) => ({
  active: { id: `${from}:${code}`, data: { current: { type: 'entry', code, name, folderId: from } } },
  over: { id: `folder:${to}`, data: { current: { type: 'entry-target', folderId: to } } },
  activatorEvent: { ctrlKey: ctrl },
});

function renderBoard(props: Partial<React.ComponentProps<typeof HeatmapBoard>> = {}) {
  return render(<HeatmapBoard groups={groups} quoteByCode={new Map<string, LiveQuote>()}
    sortMode="manual" onPick={() => {}} {...props} />);
}

/** 드래그 1회 = onDragStart(수정자 시드) → onDragEnd. seed 가 없으면 Ctrl 판정이 안 선다. */
function drag(ev: ReturnType<typeof toGroup>) {
  h.onDragStart!({ active: ev.active, activatorEvent: ev.activatorEvent });
  h.onDragEnd!(ev);
}

beforeEach(() => {
  h.onDragStart = null;
  h.onDragEnd = null;
});

describe('HeatmapBoard 그룹 간 드래그', () => {
  it('다른 그룹에 드롭 → onMove(code, from, to)', () => {
    const onMove = vi.fn();
    renderBoard({ onMove });
    drag(toGroup('005930', '삼성전자', 'f1', 'f2', false));
    expect(onMove).toHaveBeenCalledWith('005930', 'f1', 'f2');
  });

  it('Ctrl 을 누른 채 드롭 → onCopy(code, name, to) — 이동이 아니다', () => {
    const onMove = vi.fn();
    const onCopy = vi.fn();
    renderBoard({ onMove, onCopy });
    drag(toGroup('005930', '삼성전자', 'f1', 'f2', true));
    expect(onCopy).toHaveBeenCalledWith('005930', '삼성전자', 'f2');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('Ctrl 이어도 onCopy 미주입이면 이동으로 강등(드래그를 삼키지 않는다)', () => {
    const onMove = vi.fn();
    renderBoard({ onMove });
    drag(toGroup('005930', '삼성전자', 'f1', 'f2', true));
    expect(onMove).toHaveBeenCalledWith('005930', 'f1', 'f2');
  });

  it('같은 그룹에 드롭 → no-op', () => {
    const onMove = vi.fn();
    const onCopy = vi.fn();
    renderBoard({ onMove, onCopy });
    drag(toGroup('005930', '삼성전자', 'f1', 'f1', true));
    expect(onMove).not.toHaveBeenCalled();
    expect(onCopy).not.toHaveBeenCalled();
  });

  it('같은 그룹 형제 행 위 = 그룹 내 재정렬(이동/복제 아님)', () => {
    const onReorder = vi.fn();
    const onMove = vi.fn();
    renderBoard({ onReorder, onMove });
    h.onDragStart!({ active: { id: 'f1:005930' }, activatorEvent: { ctrlKey: false } });
    h.onDragEnd!({
      active: { id: 'f1:005930', data: { current: { type: 'entry', code: '005930', name: '삼성전자', folderId: 'f1' } } },
      over: { id: 'f1:000660', data: { current: { type: 'entry', code: '000660', folderId: 'f1' } } },
      activatorEvent: { ctrlKey: false },
    });
    expect(onReorder).toHaveBeenCalledWith('f1', ['000660', '005930']);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('onMove 미주입 + 라이브 정렬(desc) → DndContext 자체가 없다(드래그 비활성)', () => {
    renderBoard({ sortMode: 'desc' });
    expect(h.onDragEnd).toBeNull();
    // 그래도 보드는 정상 렌더된다.
    expect(screen.getByText('반도체')).toBeInTheDocument();
  });

  it('라이브 정렬(desc)이어도 onMove 가 있으면 그룹 간 드래그는 열린다', () => {
    const onMove = vi.fn();
    renderBoard({ sortMode: 'desc', onMove });
    drag(toGroup('005930', '삼성전자', 'f1', 'f2', false));
    expect(onMove).toHaveBeenCalledWith('005930', 'f1', 'f2');
  });
});

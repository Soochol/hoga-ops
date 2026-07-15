import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { LiveDetailPanel } from './LiveDetailPanel';
import { DEFAULT_CARD_WEIGHTS, LIVE_CARD_KEYS, useLiveLayoutStore } from '../state/liveLayout';

// dnd-kit 은 실제 포인터 드래그를 jsdom 에서 구동하기 어려우므로, DndContext 의
// 핸들러를 캡처해 합성 이벤트로 직접 호출한다(StudyViewsDrawer.test 패턴).
const dnd = vi.hoisted<{
  onDragStart: null | ((e: unknown) => void);
  onDragOver: null | ((e: unknown) => void);
  onDragEnd: null | ((e: unknown) => void);
}>(() => ({ onDragStart: null, onDragOver: null, onDragEnd: null }));

vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragStart, onDragOver, onDragEnd }: {
      children: React.ReactNode;
      onDragStart?: (e: unknown) => void;
      onDragOver?: (e: unknown) => void;
      onDragEnd?: (e: unknown) => void;
    }) => {
      dnd.onDragStart = onDragStart ?? null;
      dnd.onDragOver = onDragOver ?? null;
      dnd.onDragEnd = onDragEnd ?? null;
      return <>{children}</>;
    },
    DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSensor: () => ({}),
    useSensors: () => [],
    PointerSensor: class {},
  };
});

vi.mock('@dnd-kit/sortable', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: () => ({
      attributes: {},
      setNodeRef: () => {},
      listeners: {},
      transform: null,
      transition: undefined,
      isDragging: false,
    }),
  };
});

function renderPanel(overrides: Record<string, React.ReactNode> = {}) {
  return render(
    <LiveDetailPanel
      orderbook={<div>orderbook</div>}
      volumeDistribution={<div>volume</div>}
      program={<div>program</div>}
      brokers={<div>brokers</div>}
      investor={<div>investor</div>}
      {...overrides}
    />,
  );
}

describe('LiveDetailPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    useLiveLayoutStore.setState({
      rightPanelWidthPx: 400,
      rightCardWeights: DEFAULT_CARD_WEIGHTS,
      rightCardOrder: [...LIVE_CARD_KEYS],
      rightCardHidden: {},
      rightCardCollapsed: {},
      detailPanelCollapsed: false,
    });
  });

  it('renders the indicator cards in canonical order (brokers above volume distribution)', () => {
    renderPanel();

    const orderbook = screen.getByTestId('live-detail-card-orderbook');
    const volumeDistribution = screen.getByTestId('live-detail-card-volumeDistribution');
    const program = screen.getByTestId('live-detail-card-program');
    const brokers = screen.getByTestId('live-detail-card-brokers');
    const investor = screen.getByTestId('live-detail-card-investor');
    expect(orderbook.compareDocumentPosition(brokers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(brokers.compareDocumentPosition(volumeDistribution) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(volumeDistribution.compareDocumentPosition(program) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(program.compareDocumentPosition(investor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(orderbook).not.toContainElement(volumeDistribution);
  });

  it('keeps every slot mounted when content is empty', () => {
    renderPanel({ orderbook: null, volumeDistribution: null, program: null, brokers: null, investor: null });

    for (const key of ['orderbook', 'volumeDistribution', 'program', 'brokers', 'investor']) {
      expect(screen.getByTestId(`live-detail-card-${key}`)).toBeInTheDocument();
    }
  });

  it('does not create per-indicator scroll containers; the whole detail panel scrolls instead', () => {
    renderPanel();
    for (const key of ['orderbook', 'volumeDistribution', 'program', 'brokers', 'investor']) {
      expect(screen.getByTestId(`live-detail-card-${key}`)).not.toHaveClass('overflow-hidden');
      expect(screen.getByTestId(`live-detail-content-${key}`)).not.toHaveClass('overflow-auto');
      expect(screen.getByTestId(`live-detail-content-${key}`)).not.toHaveClass('overflow-hidden');
    }
    expect(screen.getByTestId('live-detail-panel')).toHaveClass('min-h-full');
  });

  it('renders each detail section as a bounded independent card (border + rounded + surface)', () => {
    renderPanel();
    const orderbook = screen.getByTestId('live-detail-card-orderbook');
    expect(orderbook).toHaveClass('rounded-lg');
    expect(orderbook).toHaveClass('border');
    expect(orderbook).toHaveClass('bg-bg-card');
    expect(orderbook).toHaveClass('shadow-panel');
    expect(orderbook).not.toHaveClass('overflow-hidden');
  });

  it('has no per-card collapse toggle and no collapse-all control', () => {
    renderPanel();
    // 접기 기능 제거 — 카드 토글 버튼도, "모두 접기" 컨트롤도 없다.
    expect(screen.queryByTestId('live-detail-toggle-orderbook')).toBeNull();
    expect(screen.queryByTestId('live-detail-collapse-all')).toBeNull();
  });

  it('places the drag handle in the header before the title (left), hide button after', () => {
    renderPanel();
    const handle = screen.getByTestId('live-detail-drag-orderbook');
    const hide = screen.getByTestId('live-detail-hide-orderbook');
    const title = screen.getByText('10호가');
    // 드래그 핸들이 제목보다 앞(왼쪽), 숨김 버튼이 제목보다 뒤(오른쪽).
    expect(handle.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(hide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('collapses the whole detail panel from the control bar « button', () => {
    renderPanel();
    act(() => {
      screen.getByTestId('live-detail-panel-collapse').click();
    });
    expect(useLiveLayoutStore.getState().detailPanelCollapsed).toBe(true);
  });

  it('renders cards in the persisted order', () => {
    useLiveLayoutStore.setState({
      rightCardOrder: ['volumeDistribution', 'orderbook', 'brokers', 'program', 'investor'],
    });
    renderPanel();
    const volume = screen.getByTestId('live-detail-card-volumeDistribution');
    const orderbook = screen.getByTestId('live-detail-card-orderbook');
    expect(volume.compareDocumentPosition(orderbook) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides a card (unmount) and restores it from the + menu', () => {
    renderPanel();
    expect(screen.getByTestId('live-detail-card-program')).toBeInTheDocument();

    act(() => {
      screen.getByTestId('live-detail-hide-program').click();
    });
    expect(useLiveLayoutStore.getState().rightCardHidden.program).toBe(true);
    expect(screen.queryByTestId('live-detail-card-program')).toBeNull();

    act(() => {
      screen.getByTestId('live-detail-restore').click();
    });
    act(() => {
      screen.getByTestId('live-detail-restore-item-program').click();
    });
    expect(useLiveLayoutStore.getState().rightCardHidden.program).toBe(false);
    expect(screen.getByTestId('live-detail-card-program')).toBeInTheDocument();
  });

  it('dispatches a reorder on drag end via reorderVisible over the full order', () => {
    renderPanel();
    act(() => {
      dnd.onDragEnd?.({ active: { id: 'investor' }, over: { id: 'orderbook' } });
    });
    expect(useLiveLayoutStore.getState().rightCardOrder).toEqual([
      'investor', 'orderbook', 'brokers', 'volumeDistribution', 'program',
    ]);
  });

  it('keeps hidden cards anchored when reordering visible cards', () => {
    useLiveLayoutStore.setState({ rightCardHidden: { brokers: true } });
    renderPanel();
    act(() => {
      dnd.onDragEnd?.({ active: { id: 'orderbook' }, over: { id: 'program' } });
    });
    expect(useLiveLayoutStore.getState().rightCardOrder).toEqual([
      'volumeDistribution', 'brokers', 'program', 'orderbook', 'investor',
    ]);
  });

  it('shows an insertion line on the drop-target card while dragging', () => {
    renderPanel();
    // orderbook(idx0)을 program(idx3) 위로 드래그 → program 아래(bottom)에 삽입선.
    act(() => {
      dnd.onDragStart?.({ active: { id: 'orderbook' } });
    });
    act(() => {
      dnd.onDragOver?.({ active: { id: 'orderbook' }, over: { id: 'program' } });
    });
    expect(screen.getByTestId('live-detail-drop-program')).toBeInTheDocument();
    // active 카드 자신엔 삽입선 없음.
    expect(screen.queryByTestId('live-detail-drop-orderbook')).toBeNull();

    // 드래그 종료 시 삽입선 사라짐.
    act(() => {
      dnd.onDragEnd?.({ active: { id: 'orderbook' }, over: { id: 'program' } });
    });
    expect(screen.queryByTestId('live-detail-drop-program')).toBeNull();
  });
});

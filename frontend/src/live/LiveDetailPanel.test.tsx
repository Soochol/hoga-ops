import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { LiveDetailPanel } from './LiveDetailPanel';
import * as liveLayout from '../state/liveLayout';
import { DEFAULT_CARD_WEIGHTS, LIVE_CARD_KEYS, useLiveLayoutStore } from '../state/liveLayout';

// dnd-kit 은 실제 포인터 드래그를 jsdom 에서 구동하기 어려우므로, DndContext 의
// onDragEnd 를 캡처해 합성 이벤트로 직접 호출한다(StudyViewsDrawer.test 패턴).
const dnd = vi.hoisted<{ onDragEnd: null | ((event: unknown) => void) }>(() => ({ onDragEnd: null }));

vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd?: (e: unknown) => void }) => {
      dnd.onDragEnd = onDragEnd ?? null;
      return <>{children}</>;
    },
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

  it('renders the fixed indicator slots in order, with brokers above volume distribution', () => {
    render(
      <LiveDetailPanel
        orderbook={<div>orderbook</div>}
        volumeDistribution={<div>volume</div>}
        program={<div>program</div>}
        brokers={<div>brokers</div>}
        investor={<div>investor</div>}
      />,
    );

    const orderbook = screen.getByTestId('live-detail-card-orderbook');
    const volumeDistribution = screen.getByTestId('live-detail-card-volumeDistribution');
    const program = screen.getByTestId('live-detail-card-program');
    const brokers = screen.getByTestId('live-detail-card-brokers');
    const investor = screen.getByTestId('live-detail-card-investor');
    expect(
      orderbook.compareDocumentPosition(brokers) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      brokers.compareDocumentPosition(volumeDistribution) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      volumeDistribution.compareDocumentPosition(program) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      program.compareDocumentPosition(investor) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(orderbook).not.toContainElement(volumeDistribution);
  });

  it('exposes splitter semantics for adjacent cards', () => {
    render(
      <LiveDetailPanel
        orderbook={<div />}
        program={<div />}
        brokers={<div />}
        investor={<div />}
      />,
    );

    expect(
      screen.getByRole('separator', { name: '10호가 / 거래원 크기 조절' }),
    ).toHaveAttribute('aria-orientation', 'horizontal');
    expect(
      screen.getByRole('separator', { name: '거래원 / 매물대 크기 조절' }),
    ).toHaveAttribute('aria-orientation', 'horizontal');
    expect(
      screen.getByRole('separator', { name: '매물대 / 프로그램 순매수 크기 조절' }),
    ).toHaveAttribute('aria-orientation', 'horizontal');
    expect(
      screen.getByRole('separator', { name: '프로그램 순매수 / 잠정투자자 크기 조절' }),
    ).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('keeps every slot mounted when content is empty', () => {
    render(<LiveDetailPanel orderbook={null} volumeDistribution={null} program={null} brokers={null} investor={null} />);

    expect(screen.getByTestId('live-detail-card-orderbook')).toBeInTheDocument();
    expect(screen.getByTestId('live-detail-card-volumeDistribution')).toBeInTheDocument();
    expect(screen.getByTestId('live-detail-card-program')).toBeInTheDocument();
    expect(screen.getByTestId('live-detail-card-brokers')).toBeInTheDocument();
    expect(screen.getByTestId('live-detail-card-investor')).toBeInTheDocument();
  });

  it('does not create per-indicator scroll containers; the whole detail panel scrolls instead', () => {
    render(
      <LiveDetailPanel
        orderbook={<div style={{ height: 900 }}>orderbook</div>}
        volumeDistribution={<div style={{ height: 500 }}>volume</div>}
        program={<div style={{ height: 300 }}>program</div>}
        brokers={<div style={{ height: 700 }}>brokers</div>}
        investor={<div style={{ height: 400 }}>investor</div>}
      />,
    );

    for (const key of ['orderbook', 'volumeDistribution', 'program', 'brokers', 'investor']) {
      expect(screen.getByTestId(`live-detail-card-${key}`)).not.toHaveClass('overflow-hidden');
      expect(screen.getByTestId(`live-detail-content-${key}`)).not.toHaveClass('overflow-auto');
      expect(screen.getByTestId(`live-detail-content-${key}`)).not.toHaveClass('overflow-hidden');
    }
  });

  it('renders each detail section as a bounded independent card (border + rounded + surface)', () => {
    render(
      <LiveDetailPanel
        orderbook={<div>orderbook</div>}
        brokers={<div>brokers</div>}
        volumeDistribution={<div>volume</div>}
        program={<div>program</div>}
        investor={<div>investor</div>}
      />,
    );

    const orderbook = screen.getByTestId('live-detail-card-orderbook');
    // 독립 카드 외관(2026-07-15) — 테두리+둥근모서리+카드 표면+그림자.
    expect(orderbook).toHaveClass('rounded-lg');
    expect(orderbook).toHaveClass('border');
    expect(orderbook).toHaveClass('bg-bg-card');
    expect(orderbook).toHaveClass('shadow-panel');
    // 카드별 스크롤 컨테이너는 여전히 금지(스크롤은 패널 레벨).
    expect(orderbook).not.toHaveClass('overflow-hidden');
  });

  it('stacks detail cards compactly instead of stretching them to fill tall chart panes', () => {
    render(
      <LiveDetailPanel
        orderbook={<div>orderbook</div>}
        volumeDistribution={<div>volume</div>}
        program={<div>program</div>}
        brokers={<div>brokers</div>}
        investor={<div>investor</div>}
      />,
    );

    const panel = screen.getByTestId('live-detail-panel');
    expect(panel.getAttribute('style') ?? '').not.toContain('fr');
    expect(screen.getByTestId('live-detail-card-orderbook')).toHaveStyle({ minHeight: '260px' });
    expect(screen.getByTestId('live-detail-card-volumeDistribution')).toHaveStyle({
      minHeight: '180px',
    });
  });

  it('resizes only the adjacent pair and persists the updated weights after dragging', () => {
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);

    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
      hasPointerCapture: { configurable: true, value: hasPointerCapture },
    });

    render(
      <LiveDetailPanel
        orderbook={<div />}
        program={<div />}
        brokers={<div />}
        investor={<div />}
      />,
    );

    const panel = screen.getByTestId('live-detail-panel');
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 1000 });

    const separator = screen.getByTestId('live-detail-resizer-orderbook-brokers');
    const PointerEvt = window.PointerEvent ?? MouseEvent;
    const nextWeights = {
      ...DEFAULT_CARD_WEIGHTS,
      orderbook: 58.2432432432,
      brokers: 2.7567567568,
    };
    const resizeSpy = vi
      .spyOn(liveLayout, 'resizeAdjacentWeights')
      .mockReturnValue(nextWeights);

    act(() => {
      separator.dispatchEvent(
        new PointerEvt('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(
        new PointerEvt('pointermove', { bubbles: true, clientY: 200, pointerId: 1 }),
      );
    });

    expect(document.body.style.cursor).toBe('row-resize');
    expect(document.body.style.userSelect).toBe('none');
    const movedWeights = useLiveLayoutStore.getState().rightCardWeights;
    expect(movedWeights.volumeDistribution).toBe(DEFAULT_CARD_WEIGHTS.volumeDistribution);
    expect(movedWeights.investor).toBe(DEFAULT_CARD_WEIGHTS.investor);
    expect(movedWeights).toEqual(nextWeights);
    expect(resizeSpy).toHaveBeenCalledWith(
      DEFAULT_CARD_WEIGHTS,
      'orderbook',
      'brokers',
      expect.any(Number),
      542.08,
    );

    act(() => {
      window.dispatchEvent(
        new PointerEvt('pointerup', { bubbles: true, clientY: 200, pointerId: 1 }),
      );
    });

    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(hasPointerCapture).toHaveBeenCalledWith(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
    expect(JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}').rightCardWeights).toEqual(
      movedWeights,
    );
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    resizeSpy.mockRestore();
  });

  it('updates the live layout state during horizontal dragging and keeps the labels exposed', () => {
    render(
      <LiveDetailPanel
        orderbook={<div />}
        program={<div />}
        brokers={<div />}
        investor={<div />}
      />,
    );

    const panel = screen.getByTestId('live-detail-panel');
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 1000 });

    const separator = screen.getByTestId('live-detail-resizer-orderbook-brokers');
    Object.defineProperty(separator, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(separator, 'releasePointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(separator, 'hasPointerCapture', { configurable: true, value: vi.fn(() => true) });

    fireEvent.pointerDown(separator, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 550 });

    const { rightCardWeights } = useLiveLayoutStore.getState();
    expect(rightCardWeights.orderbook).not.toBe(DEFAULT_CARD_WEIGHTS.orderbook);
    expect(rightCardWeights.brokers).not.toBe(DEFAULT_CARD_WEIGHTS.brokers);
    expect(rightCardWeights.orderbook + rightCardWeights.brokers).toBeCloseTo(
      DEFAULT_CARD_WEIGHTS.orderbook + DEFAULT_CARD_WEIGHTS.brokers,
      6,
    );
    expect(
      screen.getByRole('separator', { name: '10호가 / 거래원 크기 조절' }),
    ).toHaveAttribute('aria-orientation', 'horizontal');

    fireEvent.pointerUp(window, { pointerId: 1, clientY: 550 });
  });

  it('allows the detail stack to scroll when card minimum heights exceed the available height', () => {
    render(
      <LiveDetailPanel
        orderbook={<div style={{ height: 260 }}>orderbook</div>}
        program={<div style={{ height: 96 }}>program</div>}
        brokers={<div style={{ height: 160 }}>brokers</div>}
        investor={<div style={{ height: 120 }}>investor</div>}
      />,
    );

    expect(screen.getByTestId('live-detail-panel')).toHaveClass('min-h-full');
  });

  it('toggles a single card via its header button and persists the collapsed flag', () => {
    render(
      <LiveDetailPanel
        orderbook={<div>orderbook</div>}
        volumeDistribution={<div>volume</div>}
        program={<div>program</div>}
        brokers={<div>brokers</div>}
        investor={<div>investor</div>}
      />,
    );

    // 펼침 기본: 본문(content wrapper)이 마운트되어 있다.
    expect(screen.getByTestId('card-orderbook')).toBeInTheDocument();

    act(() => {
      screen.getByTestId('live-detail-toggle-orderbook').click();
    });

    expect(useLiveLayoutStore.getState().rightCardCollapsed.orderbook).toBe(true);
    expect(
      JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}').rightCardCollapsed.orderbook,
    ).toBe(true);
    // 접힘: 본문 unmount, minHeight 강등, 카드 래퍼는 유지.
    expect(screen.queryByTestId('card-orderbook')).toBeNull();
    expect(screen.getByTestId('live-detail-card-orderbook').style.minHeight).toBe('');
  });

  it('renders the empty dot only for collapsed empty cards', () => {
    useLiveLayoutStore.setState({ rightCardCollapsed: { orderbook: true, brokers: true } });
    render(
      <LiveDetailPanel
        orderbook={<div />}
        volumeDistribution={<div />}
        program={<div />}
        brokers={<div />}
        investor={<div />}
        emptyByCard={{ orderbook: true, brokers: false }}
      />,
    );

    // orderbook 접힘 + 비었음 → 점 표시(sr-only "데이터 없음").
    const orderbookToggle = screen.getByTestId('live-detail-toggle-orderbook');
    expect(orderbookToggle.textContent).toContain('데이터 없음');
    // brokers 접힘이나 데이터 있음 → 점 없음.
    const brokersToggle = screen.getByTestId('live-detail-toggle-brokers');
    expect(brokersToggle.textContent).not.toContain('데이터 없음');
  });

  it('makes the resizer inert when a neighbor is collapsed while others still drag', () => {
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    });
    // 거래원 접힘 → 10호가/거래원, 거래원/매물대 리사이저가 inert.
    useLiveLayoutStore.setState({ rightCardCollapsed: { brokers: true } });
    render(
      <LiveDetailPanel
        orderbook={<div />}
        volumeDistribution={<div />}
        program={<div />}
        brokers={<div />}
        investor={<div />}
      />,
    );

    const inertResizer = screen.getByTestId('live-detail-resizer-orderbook-brokers');
    expect(inertResizer).toHaveAttribute('aria-disabled', 'true');

    const panel = screen.getByTestId('live-detail-panel');
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 1000 });
    const PointerEvt = window.PointerEvent ?? MouseEvent;
    const before = useLiveLayoutStore.getState().rightCardWeights;
    act(() => {
      inertResizer.dispatchEvent(
        new PointerEvt('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(
        new PointerEvt('pointermove', { bubbles: true, clientY: 300, pointerId: 1 }),
      );
    });
    // inert 리사이저는 드래그해도 weights 불변.
    expect(useLiveLayoutStore.getState().rightCardWeights).toEqual(before);

    // 접힘과 무관한 매물대/프로그램 리사이저는 여전히 활성.
    expect(
      screen.getByTestId('live-detail-resizer-volumeDistribution-program'),
    ).not.toHaveAttribute('aria-disabled');
  });

  it('collapses and expands all cards from the control bar toggle', () => {
    render(
      <LiveDetailPanel
        orderbook={<div />}
        volumeDistribution={<div />}
        program={<div />}
        brokers={<div />}
        investor={<div />}
      />,
    );

    const allToggle = screen.getByTestId('live-detail-collapse-all');
    expect(allToggle.textContent).toBe('모두 접기');
    act(() => {
      allToggle.click();
    });
    expect(screen.queryByTestId('card-orderbook')).toBeNull();
    expect(screen.queryByTestId('card-investor')).toBeNull();
    expect(screen.getByTestId('live-detail-collapse-all').textContent).toBe('모두 펴기');
  });

  it('collapses the whole detail panel from the control bar « button', () => {
    render(
      <LiveDetailPanel
        orderbook={<div />}
        volumeDistribution={<div />}
        program={<div />}
        brokers={<div />}
        investor={<div />}
      />,
    );

    act(() => {
      screen.getByTestId('live-detail-panel-collapse').click();
    });
    expect(useLiveLayoutStore.getState().detailPanelCollapsed).toBe(true);
  });

  it('renders cards in the persisted order and recomputes resizer adjacency', () => {
    useLiveLayoutStore.setState({
      rightCardOrder: ['volumeDistribution', 'orderbook', 'brokers', 'program', 'investor'],
    });
    render(
      <LiveDetailPanel
        orderbook={<div>orderbook</div>}
        volumeDistribution={<div>volume</div>}
        program={<div>program</div>}
        brokers={<div>brokers</div>}
        investor={<div>investor</div>}
      />,
    );

    const volume = screen.getByTestId('live-detail-card-volumeDistribution');
    const orderbook = screen.getByTestId('live-detail-card-orderbook');
    expect(
      volume.compareDocumentPosition(orderbook) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // 새 인접쌍: 매물대/10호가 리사이저가 생기고, 기존 10호가/거래원 순서는 유지.
    expect(
      screen.getByRole('separator', { name: '매물대 / 10호가 크기 조절' }),
    ).toBeInTheDocument();
  });

  it('hides a card (unmount) and drops it to three separators, then restores it', () => {
    render(
      <LiveDetailPanel
        orderbook={<div>orderbook</div>}
        volumeDistribution={<div>volume</div>}
        program={<div>program</div>}
        brokers={<div>brokers</div>}
        investor={<div>investor</div>}
      />,
    );

    expect(screen.getAllByRole('separator')).toHaveLength(4);

    act(() => {
      screen.getByTestId('live-detail-hide-program').click();
    });

    expect(useLiveLayoutStore.getState().rightCardHidden.program).toBe(true);
    // 숨김 = unmount(접힘과 달리 카드 래퍼 자체가 사라진다).
    expect(screen.queryByTestId('live-detail-card-program')).toBeNull();
    expect(screen.getAllByRole('separator')).toHaveLength(3);

    // 복구 메뉴에서 다시 표시.
    act(() => {
      screen.getByTestId('live-detail-restore').click();
    });
    act(() => {
      screen.getByTestId('live-detail-restore-item-program').click();
    });
    expect(useLiveLayoutStore.getState().rightCardHidden.program).toBe(false);
    expect(screen.getByTestId('live-detail-card-program')).toBeInTheDocument();
    expect(screen.getAllByRole('separator')).toHaveLength(4);
  });

  it('dispatches a reorder on drag end via reorderVisible over the full order', () => {
    render(
      <LiveDetailPanel
        orderbook={<div />}
        volumeDistribution={<div />}
        program={<div />}
        brokers={<div />}
        investor={<div />}
      />,
    );

    // 잠정투자자(visible index 4)를 10호가(index 0) 위치로 이동.
    act(() => {
      dnd.onDragEnd?.({ active: { id: 'investor' }, over: { id: 'orderbook' } });
    });

    expect(useLiveLayoutStore.getState().rightCardOrder).toEqual([
      'investor', 'orderbook', 'brokers', 'volumeDistribution', 'program',
    ]);
  });

  it('keeps hidden cards anchored when reordering visible cards', () => {
    useLiveLayoutStore.setState({ rightCardHidden: { brokers: true } });
    render(
      <LiveDetailPanel
        orderbook={<div />}
        volumeDistribution={<div />}
        program={<div />}
        brokers={<div />}
        investor={<div />}
      />,
    );

    // visible = [orderbook, volumeDistribution, program, investor] (brokers 숨김, index 1 고정).
    // orderbook(0) → program(index 2) 위치로.
    act(() => {
      dnd.onDragEnd?.({ active: { id: 'orderbook' }, over: { id: 'program' } });
    });

    // brokers 는 전체 순서 index 1 에 고정 유지.
    expect(useLiveLayoutStore.getState().rightCardOrder).toEqual([
      'volumeDistribution', 'brokers', 'program', 'orderbook', 'investor',
    ]);
  });
});

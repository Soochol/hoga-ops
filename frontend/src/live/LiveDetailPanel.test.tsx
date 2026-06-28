import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { LiveDetailPanel } from './LiveDetailPanel';
import * as liveLayout from '../state/liveLayout';
import { DEFAULT_CARD_WEIGHTS, useLiveLayoutStore } from '../state/liveLayout';

describe('LiveDetailPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    useLiveLayoutStore.setState({
      rightPanelWidthPx: 400,
      rightCardWeights: DEFAULT_CARD_WEIGHTS,
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

  it('renders detail sections as flat sections inside the outer panel', () => {
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
    expect(orderbook).not.toHaveClass('rounded');
    expect(orderbook).not.toHaveClass('bg-bg-card');
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
});

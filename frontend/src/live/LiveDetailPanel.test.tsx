import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('renders the four fixed slots in order', () => {
    render(
      <LiveDetailPanel
        orderbook={<div>orderbook</div>}
        program={<div>program</div>}
        brokers={<div>brokers</div>}
        investor={<div>investor</div>}
      />,
    );

    const orderbook = screen.getByTestId('live-detail-card-orderbook');
    const program = screen.getByTestId('live-detail-card-program');
    const brokers = screen.getByTestId('live-detail-card-brokers');
    const investor = screen.getByTestId('live-detail-card-investor');
    expect(
      orderbook.compareDocumentPosition(program) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      program.compareDocumentPosition(brokers) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      brokers.compareDocumentPosition(investor) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
      screen.getByRole('separator', { name: '10호가 / 프로그램 순매수 크기 조절' }),
    ).toHaveAttribute('aria-orientation', 'horizontal');
    expect(
      screen.getByRole('separator', { name: '프로그램 순매수 / 거래원 크기 조절' }),
    ).toHaveAttribute('aria-orientation', 'horizontal');
    expect(
      screen.getByRole('separator', { name: '거래원 / 잠정투자자 크기 조절' }),
    ).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('keeps every slot mounted when content is empty', () => {
    render(<LiveDetailPanel orderbook={null} program={null} brokers={null} investor={null} />);

    expect(screen.getByTestId('live-detail-card-orderbook')).toBeInTheDocument();
    expect(screen.getByTestId('live-detail-card-program')).toBeInTheDocument();
    expect(screen.getByTestId('live-detail-card-brokers')).toBeInTheDocument();
    expect(screen.getByTestId('live-detail-card-investor')).toBeInTheDocument();
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

    const separator = screen.getByTestId('live-detail-resizer-orderbook-program');
    const PointerEvt = window.PointerEvent ?? MouseEvent;
    const nextWeights = {
      ...DEFAULT_CARD_WEIGHTS,
      orderbook: 58.2432432432,
      program: 2.7567567568,
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

    const movedWeights = useLiveLayoutStore.getState().rightCardWeights;
    expect(movedWeights.brokers).toBe(DEFAULT_CARD_WEIGHTS.brokers);
    expect(movedWeights.investor).toBe(DEFAULT_CARD_WEIGHTS.investor);
    expect(movedWeights).toEqual(nextWeights);
    expect(resizeSpy).toHaveBeenCalledWith(
      DEFAULT_CARD_WEIGHTS,
      'orderbook',
      'program',
      expect.any(Number),
      595.36,
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
    resizeSpy.mockRestore();
  });
});

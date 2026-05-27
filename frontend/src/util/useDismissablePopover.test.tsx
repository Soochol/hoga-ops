// frontend/src/util/useDismissablePopover.test.tsx
//
// Direct tests for the popover-dismissal contract — kept on the hook so
// the contract is asserted once and consumers (DrawingMenu, DrawingPropertyPanel,
// SymbolSearch, …) inherit the guarantee instead of re-asserting it.

import { render, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { useDismissablePopover } from './useDismissablePopover';

function Harness({
  isOpen,
  onDismiss,
}: {
  isOpen: boolean;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissablePopover(isOpen, ref, onDismiss);
  return (
    <div>
      <div ref={ref} data-testid="anchor">
        <button data-testid="inside">inside</button>
      </div>
      <button data-testid="outside">outside</button>
    </div>
  );
}

describe('useDismissablePopover', () => {
  it('does not fire dismiss while closed', () => {
    const onDismiss = vi.fn();
    render(<Harness isOpen={false} onDismiss={onDismiss} />);
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses on outside mousedown when open', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<Harness isOpen={true} onDismiss={onDismiss} />);
    fireEvent.mouseDown(getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('does not dismiss on mousedown inside the anchor', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<Harness isOpen={true} onDismiss={onDismiss} />);
    fireEvent.mouseDown(getByTestId('inside'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses on Escape when open', () => {
    const onDismiss = vi.fn();
    render(<Harness isOpen={true} onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('ignores non-Escape keys', () => {
    const onDismiss = vi.fn();
    render(<Harness isOpen={true} onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'a' });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('cleans up listeners on unmount', () => {
    const onDismiss = vi.fn();
    const { unmount } = render(<Harness isOpen={true} onDismiss={onDismiss} />);
    unmount();
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('removes listeners when isOpen flips to false', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Harness isOpen={true} onDismiss={onDismiss} />);
    rerender(<Harness isOpen={false} onDismiss={onDismiss} />);
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // /review audit gap: the hook's contract docs claim "anchor-internal
  // mousedown is suppressed so the trigger button can toggle without the
  // global handler immediately closing what it just opened". Pin that
  // behavior here — without the suppression, every trigger-click would
  // both open via the consumer's handler AND immediately fire onDismiss.
  it('does not dismiss when mousedown lands on the trigger inside the anchor', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<Harness isOpen={true} onDismiss={onDismiss} />);
    fireEvent.mouseDown(getByTestId('inside'));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

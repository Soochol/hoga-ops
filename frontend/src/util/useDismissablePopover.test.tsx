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

/** 포털 소비자(MAStylePicker·ColorSwatchPicker)의 형상 — 레이어가 앵커 서브트리
 *  **밖**에 있다. 두 형제 노드로 세워 `anchorRef.contains` 만으로는 레이어 내부
 *  mousedown 을 구할 수 없음을 재현한다. */
function PortalHarness({
  isOpen,
  onDismiss,
}: {
  isOpen: boolean;
  onDismiss: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(isOpen, anchorRef, onDismiss, layerRef);
  return (
    <div>
      <div ref={anchorRef} data-testid="anchor">
        <button data-testid="trigger">trigger</button>
      </div>
      <div ref={layerRef} data-testid="layer">
        <button data-testid="in-layer">in-layer</button>
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

  // layerRef: 포털된 팝오버는 앵커 서브트리 밖이라 그 안의 mousedown 이 "바깥" 으로
  // 잡힌다 — 누르는 순간 닫히고 click 이 영영 오지 않아 선택이 통째로 죽는다.
  // 막는 방향: 소비자가 layerRef 를 안 넘기거나 훅이 그 검사를 잃으면 첫 건이 빨개진다.
  it('레이어 내부 mousedown 은 dismiss 하지 않는다 (포털 소비자)', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<PortalHarness isOpen={true} onDismiss={onDismiss} />);
    fireEvent.mouseDown(getByTestId('in-layer'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('레이어를 넘겨도 앵커·레이어 둘 다 바깥이면 dismiss 한다', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<PortalHarness isOpen={true} onDismiss={onDismiss} />);
    fireEvent.mouseDown(getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledOnce();
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

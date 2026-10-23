import { useRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRightDragSelection } from './useRightDragSelection';
import type { MarqueeDraft } from './tools';

function setup() {
  const commit = vi.fn(), click = vi.fn(), intersecting = vi.fn(() => ['a', 'locked']);
  const draft = { current: null as MarqueeDraft | null };
  const preview = { current: null as ReadonlySet<string> | null };
  function Harness({ enabled = true, scope = 'first' }) {
    const containerRef = useRef<HTMLDivElement>(null);
    useRightDragSelection({ containerRef, enabled, scope, draft, preview,
      bounds: () => ({ x1: 0, y1: 0, x2: 200, y2: 100 }),
      selected: () => ['old'], intersecting, commit, click, redraw: vi.fn() });
    return <div><canvas data-testid="canvas" /><button>options</button><div ref={containerRef} data-testid="overlay" /></div>;
  }
  const result = render(<Harness />);
  const canvas = result.getByTestId('canvas');
  const down = (x = 10, y = 10, shiftKey = false) => fireEvent.pointerDown(canvas,
    { pointerId: 7, button: 2, buttons: 2, clientX: x, clientY: y, shiftKey });
  const move = (x = 60, y = 70) => fireEvent.pointerMove(window,
    { pointerId: 7, buttons: 2, clientX: x, clientY: y });
  const up = (x = 60, y = 70) => fireEvent.pointerUp(window,
    { pointerId: 7, button: 2, buttons: 0, clientX: x, clientY: y });
  return { ...result, Harness, canvas, down, move, up, draft, preview, commit, click, intersecting };
}

describe('right-button chart selection', () => {
  it('starts through the pass-through canvas, previews without committing, and replaces on release', () => {
    const h = setup();
    h.down(); h.move();
    expect(h.preview.current).toEqual(new Set(['a', 'locked']));
    expect(h.commit).not.toHaveBeenCalled();
    h.up();
    expect(h.commit).toHaveBeenCalledExactlyOnceWith(['a', 'locked']);
    expect(h.click).not.toHaveBeenCalled();
    expect(h.draft.current).toBeNull();
    expect(h.preview.current).toBeNull();
  });

  it('freezes Shift at press and adds to the original selection', () => {
    const h = setup(); h.down(10, 10, true); h.move(); h.up();
    expect(h.commit).toHaveBeenCalledWith(['old', 'a', 'locked']);
  });

  it('a reverse box over empty space replaces the selection with an empty set', () => {
    const h = setup(); h.intersecting.mockReturnValue([]);
    h.down(80, 90); h.move(10, 10); h.up(10, 10);
    expect(h.intersecting).toHaveBeenLastCalledWith({ x1: 10, y1: 10, x2: 80, y2: 90 });
    expect(h.commit).toHaveBeenCalledWith([]);
  });

  it('keeps right-click behavior below 5px and suppresses press/release context menus', () => {
    const h = setup(); h.down();
    expect(fireEvent.contextMenu(h.canvas)).toBe(false);
    expect(h.draft.current).not.toBeNull();
    h.move(13, 13);
    expect(h.preview.current).toBeNull();
    h.up(13, 13);
    expect(h.click).toHaveBeenCalledOnce();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('the trailing contextmenu cannot clear a committed selection', () => {
    const h = setup(); h.down(); h.move(); h.up();
    const bubble = vi.fn(); h.canvas.addEventListener('contextmenu', bubble);
    expect(fireEvent.contextMenu(h.canvas)).toBe(false);
    expect(bubble).not.toHaveBeenCalled();
    expect(h.click).not.toHaveBeenCalled();
  });

  it('clamps to the originating candle pane even when the pointer leaves the chart', () => {
    const h = setup(); h.down(); h.move(500, 500); h.up(500, 500);
    expect(h.intersecting).toHaveBeenLastCalledWith({ x1: 10, y1: 10, x2: 200, y2: 100 });
    expect(h.commit).toHaveBeenCalledOnce();
  });

  it.each(['Escape', 'pointercancel', 'lostpointercapture', 'blur', 'scope', 'disable', 'unmount'])(
    '%s cancels without changing the original selection or leaving a draft', action => {
      const h = setup(); h.down(); h.move();
      switch (action) {
        case 'Escape': fireEvent.keyDown(window, { key: 'Escape' }); break;
        case 'pointercancel': fireEvent.pointerCancel(window, { pointerId: 7 }); break;
        case 'lostpointercapture': fireEvent(h.getByTestId('overlay'), new PointerEvent('lostpointercapture', { pointerId: 7 })); break;
        case 'blur': fireEvent.blur(window); break;
        case 'scope': h.rerender(<h.Harness scope="second" />); break;
        case 'disable': h.rerender(<h.Harness enabled={false} />); break;
        case 'unmount': h.unmount(); break;
      }
      h.up();
      expect(h.commit).not.toHaveBeenCalled();
      expect(h.click).not.toHaveBeenCalled();
      expect(h.draft.current).toBeNull();
      expect(h.preview.current).toBeNull();
    },
  );

  it('ignores controls, axis gutters, other panes, and left presses', () => {
    const h = setup();
    fireEvent.pointerDown(h.getByRole('button'), { button: 2, buttons: 2, pointerId: 7 });
    h.down(220, 30); h.down(30, 130);
    fireEvent.pointerDown(h.canvas, { button: 0, buttons: 1, pointerId: 7 });
    h.move(); h.up();
    expect(h.draft.current).toBeNull();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.click).not.toHaveBeenCalled();
  });

  it('ignores unrelated pointers and recovers when the right button is lost', () => {
    const h = setup(); h.down();
    fireEvent.pointerUp(window, { pointerId: 8, button: 2 });
    expect(h.draft.current).not.toBeNull();
    act(() => fireEvent.pointerMove(window, { pointerId: 7, buttons: 0 }));
    expect(h.draft.current).toBeNull();
    expect(h.commit).not.toHaveBeenCalled();
  });
});

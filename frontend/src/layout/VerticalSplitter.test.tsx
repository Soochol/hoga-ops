import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import VerticalSplitter from './VerticalSplitter';

function renderSplitter(overrides: Partial<React.ComponentProps<typeof VerticalSplitter>> = {}) {
  const onDrag = overrides.onDrag ?? vi.fn();
  const onReset = overrides.onReset ?? vi.fn();
  const onNudge = overrides.onNudge ?? vi.fn();
  render(
    <VerticalSplitter
      ariaLabel="test splitter"
      ariaValueNow={320}
      ariaValueMin={240}
      ariaValueMax={520}
      onDrag={onDrag}
      onReset={onReset}
      onNudge={onNudge}
      {...overrides}
    />,
  );
  return { onDrag, onReset, onNudge };
}

describe('VerticalSplitter', () => {
  it('renders with separator ARIA attributes', () => {
    renderSplitter();
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    expect(sep).toHaveAttribute('aria-label', 'test splitter');
    expect(sep).toHaveAttribute('aria-valuenow', '320');
    expect(sep).toHaveAttribute('aria-valuemin', '240');
    expect(sep).toHaveAttribute('aria-valuemax', '520');
    expect(sep).toHaveAttribute('tabindex', '0');
  });

  it('calls onDrag(clientX) when dragged', () => {
    const { onDrag } = renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.mouseDown(sep, { clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 700 });
    fireEvent.mouseMove(window, { clientX: 650 });
    fireEvent.mouseUp(window);
    expect(onDrag).toHaveBeenCalledTimes(2);
    expect(onDrag).toHaveBeenNthCalledWith(1, 700);
    expect(onDrag).toHaveBeenNthCalledWith(2, 650);
  });

  it('stops calling onDrag after mouseup', () => {
    const { onDrag } = renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.mouseDown(sep, { clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 700 });
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 650 });
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it('calls onReset on double-click', () => {
    const { onReset } = renderSplitter();
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('Enter and Space call onReset', () => {
    const { onReset } = renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'Enter' });
    fireEvent.keyDown(sep, { key: ' ' });
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it('Arrow keys call onNudge with small magnitude', () => {
    const { onNudge } = renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(onNudge).toHaveBeenNthCalledWith(1, -1, 'small');
    expect(onNudge).toHaveBeenNthCalledWith(2, 1, 'small');
  });

  it('Shift+Arrow, Home, End call onNudge with large magnitude', () => {
    const { onNudge } = renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(sep, { key: 'Home' });
    fireEvent.keyDown(sep, { key: 'End' });
    expect(onNudge).toHaveBeenNthCalledWith(1, -1, 'large');
    expect(onNudge).toHaveBeenNthCalledWith(2, -1, 'large');
    expect(onNudge).toHaveBeenNthCalledWith(3, 1, 'large');
  });

  it('cleans up document.body styles on mouseup', () => {
    renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.mouseDown(sep, { clientX: 800 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.mouseUp(window);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });
});

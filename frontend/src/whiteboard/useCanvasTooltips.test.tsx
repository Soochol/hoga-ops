import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCanvasTooltips } from './useCanvasTooltips';

function Editor({ title = '선택 — V 또는 1' }) {
  const ref = useRef<HTMLDivElement>(null);
  const tooltip = useCanvasTooltips(ref);
  return <div ref={ref}>{tooltip}<button title={title}>선택</button>
    <div className="excalidraw-tooltip-wrapper" onPointerEnter={() => {
      const native = document.querySelector('.excalidraw-tooltip')!;
      native.classList.add('excalidraw-tooltip--visible');
      native.textContent = '더 많은 도구';
    }}><button>도구</button></div>
  </div>;
}
beforeEach(() => {
  vi.useFakeTimers();
  const native = document.createElement('div');
  native.className = 'excalidraw-tooltip';
  document.body.append(native);
});
afterEach(() => { cleanup(); document.querySelector('.excalidraw-tooltip')?.remove(); vi.useRealTimers(); });
const tick = async (ms = 0) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

it('native titles use the shared delayed surface and adopt dynamic titles', async () => {
  const { rerender } = render(<Editor />);
  const button = screen.getByRole('button', { name: '선택' });
  expect(button).not.toHaveAttribute('title');
  fireEvent.pointerOver(button, { buttons: 0, pointerType: 'mouse' });
  await tick();
  expect(screen.queryByRole('tooltip')).toBeNull();
  await tick(500);
  expect(screen.getByRole('tooltip')).toHaveTextContent('선택 — V 또는 1');
  expect(screen.getByRole('tooltip')).toHaveClass('tooltip-surface', 'text-tooltip');
  expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
  fireEvent.pointerOut(button);
  rerender(<Editor title="선택 — 새 설명" />);
  await tick();
  expect(button).not.toHaveAttribute('title');
  fireEvent.pointerOver(button, { buttons: 0, pointerType: 'mouse' });
  await tick(); await tick(500);
  expect(screen.getByRole('tooltip')).toHaveTextContent('새 설명');
});

it('private vendor labels use the shared tooltip without duplicate or Escape resurrection', async () => {
  render(<Editor />);
  const button = screen.getByRole('button', { name: '도구' });
  fireEvent.pointerOver(button, { buttons: 0, pointerType: 'mouse' });
  await tick(); await tick(500);
  const native = document.querySelector('.excalidraw-tooltip')!;
  expect(screen.getByRole('tooltip')).toHaveTextContent('더 많은 도구');
  expect(native).toHaveAttribute('data-canvas-tooltip-owned');
  fireEvent.keyDown(button, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(native).not.toHaveClass('excalidraw-tooltip--visible');
  expect(button.parentElement).not.toHaveAttribute('aria-describedby');
});

it('leaving before a deferred label is read never opens a stale tooltip', async () => {
  render(<Editor />);
  const button = screen.getByRole('button', { name: '도구' });
  fireEvent.pointerOver(button, { buttons: 0, pointerType: 'mouse' });
  fireEvent.pointerOut(button);
  await tick(); await tick(500);
  expect(screen.queryByRole('tooltip')).toBeNull();
});

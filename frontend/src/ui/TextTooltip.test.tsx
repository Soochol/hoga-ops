import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TextTooltip, TooltipButton } from './TextTooltip';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function hover(element: HTMLElement) {
  fireEvent.pointerEnter(element, { pointerType: 'mouse', buttons: 0 });
}
const reveal = () => act(() => vi.advanceTimersByTime(500));

it('replaces the native title with a delayed, described tooltip and keeps the button ref', () => {
  const ref = createRef<HTMLButtonElement>();
  const enter = vi.fn();
  render(<><span id="existing">기존 설명</span><TooltipButton ref={ref} title="보조지표" aria-describedby="existing" onPointerEnter={enter}>설정</TooltipButton></>);
  const button = screen.getByRole('button');
  expect(ref.current).toBe(button);
  expect(button).not.toHaveAttribute('title');
  hover(button);
  act(() => vi.advanceTimersByTime(499));
  expect(screen.queryByRole('tooltip')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('tooltip')).toHaveTextContent('보조지표');
  expect(button).toHaveAttribute('aria-describedby', `existing ${screen.getByRole('tooltip').id}`);
  expect(enter).toHaveBeenCalledOnce();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(button).toHaveAttribute('aria-describedby', 'existing');
});

it('keeps disabled reasons hoverable without enabling or clicking the button', () => {
  const click = vi.fn();
  render(<TooltipButton disabled title="분봉에서만 지원합니다" onClick={click}>저장 데이터</TooltipButton>);
  const button = screen.getByRole('button');
  hover(button); reveal();
  expect(screen.getByRole('tooltip')).toHaveTextContent('분봉에서만 지원합니다');
  fireEvent.click(button);
  expect(click).not.toHaveBeenCalled();
  expect(button).toBeDisabled();
  fireEvent.pointerLeave(button);
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('cancels pending hints on pointer exit, touch, dragging and pointer press', () => {
  render(<TooltipButton title="보조지표">설정</TooltipButton>);
  const button = screen.getByRole('button');
  hover(button);
  fireEvent.pointerLeave(button); reveal();
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.pointerEnter(button, { pointerType: 'touch', buttons: 0 }); reveal();
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.pointerEnter(button, { pointerType: 'mouse', buttons: 1 }); reveal();
  expect(screen.queryByRole('tooltip')).toBeNull();
  hover(button);
  fireEvent.pointerDown(document.body); reveal();
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('opens on keyboard focus and closes when the action opens its menu', () => {
  const { rerender } = render(<TooltipButton title="그리기" aria-expanded={false}>도구</TooltipButton>);
  const button = screen.getByRole('button');
  // jsdom does not track the browser's keyboard/pointer input modality.
  vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible');
  act(() => button.focus()); reveal();
  expect(button.matches(':focus-visible')).toBe(true);
  expect(screen.getByRole('tooltip')).toHaveTextContent('그리기');
  rerender(<TooltipButton title="그리기" aria-expanded>도구</TooltipButton>);
  expect(screen.queryByRole('tooltip')).toBeNull();
  hover(button); reveal();
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('measures the content to fit the right edge and flips above the trigger near the bottom', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'tooltip'
      ? { width: 140, height: 48 } as DOMRect
      : { left: window.innerWidth - 25, top: window.innerHeight - 24, bottom: window.innerHeight - 4 } as DOMRect;
  });
  render(<TextTooltip text="가격 × 잔량"><span>100억</span></TextTooltip>);
  hover(screen.getByText('100억')); reveal();
  const tooltip = screen.getByRole('tooltip');
  expect(tooltip.style.left).toBe(`${window.innerWidth - 148}px`);
  expect(tooltip.style.top).toBe(`${window.innerHeight - 76}px`);
  fireEvent.scroll(window);
  expect(screen.queryByRole('tooltip')).toBeNull();
});

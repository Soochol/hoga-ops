import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppTooltipHost } from './AppTooltipHost';
import { TooltipButton } from './TextTooltip';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const reveal = () => act(() => vi.advanceTimersByTime(500));
const hover = (element: Element) => fireEvent.pointerOver(element, { pointerType: 'mouse', buttons: 0 });

it('delegates disabled and nested targets without changing their layout or native semantics', () => {
  render(<><AppTooltipHost /><button disabled data-tooltip="분봉에서만 지원합니다"><span>저장 데이터</span></button></>);
  const label = screen.getByText('저장 데이터');
  hover(label);
  act(() => vi.advanceTimersByTime(499));
  expect(screen.queryByRole('tooltip')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('tooltip')).toHaveTextContent('분봉에서만 지원합니다');
  expect(label.parentElement).toBeDisabled();
  expect(label.parentElement).not.toHaveAttribute('title');
  expect(label.parentElement).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
  fireEvent.pointerOut(label, { relatedTarget: document.body });
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('uses the innermost hint and handles portaled content', () => {
  render(<><AppTooltipHost />{createPortal(<div data-tooltip="바깥 설명"><button data-tooltip="정확한 금액">100억</button></div>, document.body)}</>);
  hover(screen.getByRole('button')); reveal();
  expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  expect(screen.getByRole('tooltip')).toHaveTextContent('정확한 금액');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('supports keyboard focus and preserves existing descriptions after dismissal', () => {
  render(<><AppTooltipHost /><span id="context">기존 설명</span><button data-tooltip="순위 기준" aria-describedby="context">정렬</button></>);
  const button = screen.getByRole('button');
  vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible');
  fireEvent.focusIn(button); reveal();
  expect(screen.getByRole('tooltip')).toHaveTextContent('순위 기준');
  expect(button).toHaveAttribute('aria-describedby', `context ${screen.getByRole('tooltip').id}`);
  fireEvent.focusOut(button);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(button).toHaveAttribute('aria-describedby', 'context');
});

it('does not show pointer-only focus, touch, dragging or canceled pending hints', () => {
  render(<><AppTooltipHost /><button data-tooltip="도움말">설정</button></>);
  const button = screen.getByRole('button');
  vi.spyOn(button, 'matches').mockReturnValue(false);
  fireEvent.focusIn(button); reveal();
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.pointerOver(button, { pointerType: 'touch', buttons: 0 }); reveal();
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.pointerOver(button, { pointerType: 'mouse', buttons: 1 }); reveal();
  expect(screen.queryByRole('tooltip')).toBeNull();
  hover(button);
  fireEvent.pointerDown(document.body); reveal();
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('updates dynamic hints and removes hints when a virtual row is recycled', async () => {
  const { rerender } = render(<><AppTooltipHost /><span data-tooltip="조회 중">시세</span></>);
  hover(screen.getByText('시세')); reveal();
  expect(screen.getByRole('tooltip')).toHaveTextContent('조회 중');
  rerender(<><AppTooltipHost /><span data-tooltip="마지막 정상 시세">시세</span></>);
  await act(async () => {}); reveal();
  expect(screen.getByRole('tooltip')).toHaveTextContent('마지막 정상 시세');
  rerender(<AppTooltipHost />);
  await act(async () => {});
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('leaves removed title-bar hints suppressed and avoids duplicating explicit tooltips', () => {
  render(<><AppTooltipHost /><div className="live-window-titlebar"><button data-tooltip="금지된 제목줄 안내">최대화</button></div>
    <div data-tooltip="부모 설명"><TooltipButton title="보조지표">지표</TooltipButton></div></>);
  hover(screen.getByText('최대화')); reveal();
  expect(screen.queryByRole('tooltip')).toBeNull();
  const button = screen.getByText('지표');
  fireEvent.pointerEnter(button, { pointerType: 'mouse', buttons: 0 });
  hover(button); reveal();
  expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  expect(screen.getByRole('tooltip')).toHaveTextContent('보조지표');
});

it('does not postpone the initial reveal when a live value changes during its delay', async () => {
  const { rerender } = render(<><AppTooltipHost /><span data-tooltip="1원">시세</span></>);
  hover(screen.getByText('시세'));
  act(() => vi.advanceTimersByTime(300));
  rerender(<><AppTooltipHost /><span data-tooltip="2원">시세</span></>);
  await act(async () => {});
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole('tooltip')).toHaveTextContent('2원');
});

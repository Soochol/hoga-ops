import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeatmapRow } from './HeatmapRow';
import { STOCK_DESCRIPTION_DELAY_MS, StockDescriptionTooltipProvider } from './StockDescriptionTooltip';
import { getStockDescription } from './stockDescriptions';

const click = vi.fn();
function rows(disabled = false) {
  return <StockDescriptionTooltipProvider disabled={disabled}>
    <HeatmapRow code="066570" name="LG전자" price={100000} pct={1} onClick={click} ariaLabel="LG전자 차트 열기" testId="first" captureTitle="마지막 수집 10/22" />
    <HeatmapRow code="066570" name="LG전자 별칭" price={100000} pct={1} onClick={click} ariaLabel="LG전자 다른 그룹" testId="duplicate" />
    <HeatmapRow code="999999" name="새 종목" price={100} pct={0} onClick={click} ariaLabel="새 종목 차트 열기" testId="unknown" captureTitle="수집 이력 없음" />
  </StockDescriptionTooltipProvider>;
}
const reveal = () => act(() => vi.advanceTimersByTime(STOCK_DESCRIPTION_DELAY_MS));

beforeEach(() => { vi.useFakeTimers(); click.mockClear(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('heatmap company tooltip', () => {
  it('opens only on name hover after the delay, in a portal with capture information', () => {
    const { container } = render(rows());
    fireEvent.mouseEnter(within(screen.getByTestId('first')).getByText('100,000'));
    reveal();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText('LG전자', { exact: true }));
    act(() => vi.advanceTimersByTime(STOCK_DESCRIPTION_DELAY_MS - 1));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    const tooltip = screen.getByRole('tooltip');
    expect(container).not.toContainElement(tooltip);
    expect(tooltip).toHaveTextContent('066570');
    expect(tooltip).toHaveTextContent('마지막 수집 10/22');
    expect(within(tooltip).getByTestId('stock-description-lines').children).toHaveLength(2);
    expect(screen.getByTestId('first')).toHaveAttribute('aria-describedby', tooltip.id);
    expect(screen.getByTestId('first').firstElementChild).not.toHaveAttribute('title');
  });

  it('shares canonical prose across groups and aliases, with one tooltip at a time', () => {
    render(rows());
    fireEvent.mouseEnter(screen.getByText('LG전자', { exact: true })); reveal();
    const body = screen.getByTestId('stock-description-lines').textContent;
    fireEvent.mouseEnter(screen.getByText('LG전자 별칭')); reveal();
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    expect(screen.getByTestId('stock-description-lines')).toHaveTextContent(body!);
    expect(screen.getByRole('tooltip')).toHaveTextContent(getStockDescription('066570')!.name);
    expect(screen.getByTestId('first')).not.toHaveAttribute('aria-describedby');
  });

  it('cancels a quick hover and dismisses on Escape, scrolling, or pointer-down', () => {
    render(rows());
    const name = screen.getByText('LG전자', { exact: true });
    fireEvent.mouseEnter(name); fireEvent.mouseLeave(name); reveal();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    for (const dismiss of [() => fireEvent.keyDown(document, { key: 'Escape' }), () => fireEvent.scroll(window), () => fireEvent.pointerDown(name)]) {
      fireEvent.mouseEnter(name); reveal();
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
      dismiss();
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    }
    fireEvent.mouseEnter(name); fireEvent.scroll(window); reveal();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('remains open while reading the tooltip and keeps the row click action', () => {
    render(rows());
    const name = screen.getByText('LG전자', { exact: true });
    fireEvent.mouseEnter(name); reveal();
    const tooltip = screen.getByRole('tooltip');
    fireEvent.mouseLeave(name); fireEvent.mouseEnter(tooltip); reveal();
    expect(tooltip).toBeInTheDocument();
    fireEvent.mouseLeave(tooltip); reveal();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.click(name);
    expect(click).toHaveBeenCalledOnce();
  });

  it('closes during drag and leaves unknown Codes with their existing capture title', () => {
    const { rerender } = render(rows());
    const unknown = screen.getByText('새 종목', { exact: true });
    expect(unknown).toHaveAttribute('title', '수집 이력 없음');
    fireEvent.mouseEnter(unknown); reveal();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText('LG전자', { exact: true })); reveal();
    rerender(rows(true));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LiveToolbar } from './LiveToolbar';
import { useLivePageStore } from '../state/livePage';

function renderToolbar() {
  return render(<LiveToolbar onOpenIndicators={() => {}} onOpenSettings={() => {}} />);
}

describe('LiveToolbar', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      lastMinuteTimeframe: '1m',
      historicalFromDate: null,
    });
  });

  it('renders compact minute selector plus day/week/month controls and no year control', () => {
    renderToolbar();

    expect(screen.getByRole('button', { name: '분봉 선택 열기: 1분' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '일' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '주' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '월' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '년' })).toBeNull();
    expect(screen.queryByText('1m')).toBeNull();
    expect(screen.queryByText('D')).toBeNull();
  });

  it('opens minute list on minute timeframe and selecting a minute switches timeframe', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    const menu = screen.getByRole('menu', { name: '분봉 목록' });
    ['1분', '3분', '5분', '10분', '15분', '30분'].forEach((minuteOption) => {
      expect(within(menu).getByRole('menuitemradio', { name: minuteOption })).toBeInTheDocument();
    });
    expect(within(menu).getByRole('menuitemradio', { name: '3분' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: '3분' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('3m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
    expect(screen.getByRole('button', { name: '분봉 선택 열기: 3분' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('clicking the active minute selector again closes the minute list', () => {
    renderToolbar();

    const minuteSelector = screen.getByRole('button', { name: '분봉 선택 열기: 1분' });
    fireEvent.click(minuteSelector);
    expect(screen.getByRole('menu', { name: '분봉 목록' })).toBeInTheDocument();

    fireEvent.click(minuteSelector);

    expect(useLivePageStore.getState().candleTimeframe).toBe('1m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });

  it('from calendar timeframe, minute selector switches directly to remembered minute without opening menu', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.click(within(screen.getByRole('menu', { name: '분봉 목록' })).getByRole('menuitemradio', { name: '5분' }));
    fireEvent.click(screen.getByRole('button', { name: '일' }));
    expect(useLivePageStore.getState().candleTimeframe).toBe('D');

    fireEvent.click(screen.getByRole('button', { name: '5분봉으로 전환' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });

  it('from calendar timeframe, minute selector uses shared lastMinuteTimeframe', () => {
    useLivePageStore.setState({
      candleTimeframe: 'D',
      lastMinuteTimeframe: '10m',
      historicalFromDate: null,
    });
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '10분봉으로 전환' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('10m');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');
  });

  it('selecting a minute option updates shared lastMinuteTimeframe', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.click(within(screen.getByRole('menu', { name: '분봉 목록' })).getByRole('menuitemradio', { name: '15분' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('15m');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('15m');
  });

  it('calendar buttons switch timeframe and close an open minute menu', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    expect(screen.getByRole('menu', { name: '분봉 목록' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '주' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('W');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });

  it('month button switches to monthly timeframe', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '월' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('M');
    expect(screen.getByRole('button', { name: '월' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Escape closes the minute list without changing timeframe', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useLivePageStore.getState().candleTimeframe).toBe('1m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });

  it('outside mousedown closes the minute list without changing timeframe', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.mouseDown(document.body);

    expect(useLivePageStore.getState().candleTimeframe).toBe('1m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });

  it('renders settings button and calls onOpenSettings on click', () => {
    const onOpenSettings = vi.fn();
    render(<LiveToolbar onOpenIndicators={() => {}} onOpenSettings={onOpenSettings} />);
    const btn = screen.getByTestId('live-settings-button');
    expect(btn).toHaveClass('bg-bg-input');
    expect(btn).toHaveClass('text-fg-dim');
    fireEvent.click(btn);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('renders indicators button and calls onOpenIndicators on click', () => {
    const onOpenIndicators = vi.fn();
    render(<LiveToolbar onOpenIndicators={onOpenIndicators} onOpenSettings={() => {}} />);
    const btn = screen.getByTestId('live-indicators-button');
    expect(btn).toHaveClass('bg-bg-input');
    expect(btn).toHaveClass('text-fg-dim');
    fireEvent.click(btn);
    expect(onOpenIndicators).toHaveBeenCalledOnce();
  });

  it('places current-view save next to the drawing button', () => {
    const studySaveControl = <button type="button">현재 뷰 저장</button>;
    render(<LiveToolbar onOpenIndicators={() => {}} onOpenSettings={() => {}} studySaveControl={studySaveControl} />);

    const drawing = screen.getByRole('button', { name: '그리기' });
    const save = screen.getByRole('button', { name: '현재 뷰 저장' });

    expect(drawing.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

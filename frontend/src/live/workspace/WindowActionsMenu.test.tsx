import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WindowActionsMenu } from './WindowActionsMenu';
import { TradeWindowSettings } from './TradeWindowSettings';

describe('compact window actions', () => {
  it('keeps pinning and maximizing separate, closes after picking and restores focus', () => {
    const onPin = vi.fn();
    const onMaximize = vi.fn();
    render(<WindowActionsMenu maximized={false} alwaysOnTop={false} pinned={false} canPin
      onPin={onPin} onMaximize={onMaximize} />);
    const trigger = screen.getByRole('button', { name: '창 옵션' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '종목 고정' }));
    expect(onPin).toHaveBeenCalledOnce();
    expect(onMaximize).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('cannot pin an empty window and Escape preserves all window state', () => {
    const onPin = vi.fn();
    render(<WindowActionsMenu maximized alwaysOnTop pinned={false} canPin={false} onPin={onPin} />);
    fireEvent.click(screen.getByRole('button', { name: '창 옵션' }));
    expect(screen.getByRole('button', { name: '종목 고정' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onPin).not.toHaveBeenCalled();
  });

  it('opens settings from the same menu as maximize and validates custom amounts before applying', () => {
    const apply = vi.fn();
    const maximize = vi.fn();
    render(<WindowActionsMenu maximized={false} alwaysOnTop={false} pinned={false} canPin
      onMaximize={maximize} settings={{ title: '체결창 설정', render: close => <TradeWindowSettings minAmountManwon={0}
        onApply={amount => { apply(amount); close(); }} /> }} />);
    const trigger = screen.getByRole('button', { name: '창 옵션' });
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: '창 최대화' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: '체결창 설정' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    const input = screen.getByRole('textbox', { name: '최소 금액 직접 입력' });
    fireEvent.change(input, { target: { value: '-10' } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(apply).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '2,500' } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(apply).toHaveBeenCalledWith(2500);
    expect(maximize).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '9999' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });
});

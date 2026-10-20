import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WindowSettingsPopover } from './WindowSettingsPopover';
import { TradeWindowSettings } from './TradeWindowSettings';

describe('window title-bar settings', () => {
  it('opens directly, applies the trade filter and restores focus to the gear', () => {
    const apply = vi.fn();
    render(<WindowSettingsPopover title="체결창 설정" render={close => <TradeWindowSettings minAmountManwon={0}
      onApply={amount => { apply(amount); close(); }} />} />);
    const trigger = screen.getByRole('button', { name: '체결창 설정' });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '체결창 설정' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '창 옵션' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1천만' }));
    expect(apply).toHaveBeenCalledWith(1000);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('validates custom amounts and discards unapplied text when dismissed', () => {
    const apply = vi.fn();
    render(<WindowSettingsPopover title="체결창 설정" render={close => <TradeWindowSettings minAmountManwon={0}
      onApply={amount => { apply(amount); close(); }} />} />);
    const trigger = screen.getByRole('button', { name: '체결창 설정' });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '-10' } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(apply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '2,500' } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(apply).toHaveBeenCalledWith(2500);
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '9999' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByRole('textbox')).toHaveValue('1,000');
  });

  it('outside pointerdown closes the panel even when the header cancels mousedown', () => {
    render(<><button onPointerDown={event => event.preventDefault()}>창 드래그 영역</button>
      <WindowSettingsPopover title="차트 설정" scope="모든 차트에 적용" render={() => <button>표시 설정</button>} /></>);
    const trigger = screen.getByRole('button', { name: '차트 설정' });
    fireEvent.click(trigger);
    expect(screen.getByText('모든 차트에 적용')).toBeVisible();
    fireEvent.pointerDown(screen.getByRole('button', { name: '창 드래그 영역' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

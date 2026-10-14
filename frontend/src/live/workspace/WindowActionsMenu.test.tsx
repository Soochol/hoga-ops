import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WindowActionsMenu } from './WindowActionsMenu';

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
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveToolbar } from './LiveToolbar';

describe('LiveToolbar', () => {
  it('renders settings button and calls onOpenSettings on click', () => {
    const onOpenSettings = vi.fn();
    render(<LiveToolbar onOpenIndicators={() => {}} onOpenSettings={onOpenSettings} />);
    const btn = screen.getByTestId('live-settings-button');
    fireEvent.click(btn);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('renders indicators button and calls onOpenIndicators on click', () => {
    const onOpenIndicators = vi.fn();
    render(<LiveToolbar onOpenIndicators={onOpenIndicators} onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByTestId('live-indicators-button'));
    expect(onOpenIndicators).toHaveBeenCalledOnce();
  });
});

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

  it('places current-view save next to the drawing button', () => {
    render(
      <LiveToolbar
        onOpenIndicators={() => {}}
        onOpenSettings={() => {}}
        studySaveControl={<button type="button">현재 뷰 저장</button>}
      />,
    );

    const drawing = screen.getByRole('button', { name: '그리기' });
    const save = screen.getByRole('button', { name: '현재 뷰 저장' });

    expect(drawing.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

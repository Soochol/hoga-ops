import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmModal } from './ConfirmModal';

const mount = (over: Partial<React.ComponentProps<typeof ConfirmModal>> = {}) => {
  const props = {
    message: '"급등주" 삭제?',
    confirmLabel: '삭제',
    tone: 'destructive' as const,
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<ConfirmModal {...props} />);
  return props;
};

describe('ConfirmModal', () => {
  it('renders the message and confirm label', () => {
    mount();
    expect(screen.getByText('"급등주" 삭제?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '삭제' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '취소' })).toBeInTheDocument();
  });

  it('calls onConfirm (not onClose) when the confirm button is clicked', () => {
    const { onConfirm, onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when 취소 is clicked', () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is clicked', () => {
    const { onClose, onConfirm } = mount();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onClose on Escape', () => {
    const { onClose } = mount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

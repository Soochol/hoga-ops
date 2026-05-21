import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaptureForm } from './CaptureForm';

describe('CaptureForm', () => {
  it('disables Start when fields are invalid', () => {
    render(<CaptureForm onStart={vi.fn()} />);
    const btn = screen.getByTestId('capture-start') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('enables Start with valid 6-digit code and 8-digit date', () => {
    render(<CaptureForm onStart={vi.fn()} />);
    fireEvent.change(screen.getByTestId('capture-code'), { target: { value: '005930' } });
    fireEvent.change(screen.getByTestId('capture-date'), { target: { value: '20100101' } });
    expect((screen.getByTestId('capture-start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls onStart with form values', () => {
    const onStart = vi.fn();
    render(<CaptureForm onStart={onStart} />);
    fireEvent.change(screen.getByTestId('capture-code'), { target: { value: '005930' } });
    fireEvent.change(screen.getByTestId('capture-date'), { target: { value: '20100101' } });
    fireEvent.click(screen.getByTestId('capture-start'));
    expect(onStart).toHaveBeenCalledWith({
      code: '005930', date: '20100101',
      allow_partial: false, resume: false, capture_only: false,
    });
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsRow, ToggleSwitch } from './SettingsRow';

describe('SettingsRow primitives', () => {
  it('renders a label, description, and trailing control with token classes', () => {
    render(
      <SettingsRow label="날짜 구분선 스타일" description="거래일 경계를 표시합니다.">
        <button type="button">선택</button>
      </SettingsRow>,
    );

    expect(screen.getByText('날짜 구분선 스타일')).toHaveClass('text-fg');
    expect(screen.getByText('거래일 경계를 표시합니다.')).toHaveClass('text-fg-dim');
    expect(screen.getByText('선택').parentElement).toHaveClass('justify-between');
  });

  it('dims the whole row when disabled', () => {
    render(<SettingsRow label="구간 수" description="5-30" disabled><input /></SettingsRow>);

    expect(screen.getByText('구간 수').parentElement?.parentElement).toHaveClass('opacity-50');
  });

  it('renders toggle switch states and forwards click handlers', () => {
    const onClick = vi.fn();
    const { rerender } = render(<ToggleSwitch label="프로그램 순매수 저장" checked={false} onClick={onClick} />);

    const offSwitch = screen.getByRole('switch', { name: '프로그램 순매수 저장' });
    expect(offSwitch).toHaveAttribute('aria-checked', 'false');
    expect(offSwitch).toHaveClass('bg-bg-input-hover');
    fireEvent.click(offSwitch);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<ToggleSwitch label="프로그램 순매수 저장" checked onClick={onClick} />);
    expect(screen.getByRole('switch', { name: '프로그램 순매수 저장' })).toHaveClass('bg-accent');
  });
});

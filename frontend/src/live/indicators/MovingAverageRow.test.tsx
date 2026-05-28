import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MovingAverageRow from './MovingAverageRow';
import type { LiveMAConfig } from '../../state/livePage';

const cfg: LiveMAConfig = {
  id: 'ma-1', enabled: true, period: 20, color: '#EC4899', lineWidth: 1, source: 'close',
};

describe('MovingAverageRow', () => {
  it('renders the slot label and current period', () => {
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={() => {}} onRemove={() => {}} />);
    expect(screen.getByText('기간1')).toBeTruthy();
    const periodInput = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(periodInput.value).toBe('20');
  });

  it('toggle button reflects enabled state', () => {
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={() => {}} onRemove={() => {}} />);
    const toggle = screen.getByRole('switch') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('toggle click emits onChange({enabled: false})', () => {
    const onChange = vi.fn();
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={onChange} onRemove={() => {}} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith({ enabled: false });
  });

  it('period commit on blur emits onChange({period: N})', () => {
    const onChange = vi.fn();
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={onChange} onRemove={() => {}} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ period: 50 });
  });

  it('period commit on Enter emits onChange', () => {
    const onChange = vi.fn();
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={onChange} onRemove={() => {}} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ period: 7 });
  });

  it('invalid period commit reverts the input', () => {
    const onChange = vi.fn();
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={onChange} onRemove={() => {}} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('20');
  });

  it('remove button hidden when canRemove=false', () => {
    render(<MovingAverageRow index={0} config={cfg} canRemove={false} onChange={() => {}} onRemove={() => {}} />);
    expect(screen.queryByRole('button', { name: '슬롯 삭제' })).toBeNull();
  });

  it('remove button calls onRemove when canRemove=true', () => {
    const onRemove = vi.fn();
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={() => {}} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: '슬롯 삭제' }));
    expect(onRemove).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MASourceSelect from './MASourceSelect';

describe('MASourceSelect', () => {
  it('renders all 7 source options', () => {
    render(<MASourceSelect value="close" onChange={() => {}} />);
    const opts = screen.getAllByRole('option');
    expect(opts.map((o) => o.getAttribute('value'))).toEqual([
      'close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4',
    ]);
  });

  it('displays current value as selected', () => {
    render(<MASourceSelect value="hl2" onChange={() => {}} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('hl2');
  });

  it('calls onChange when user picks a different option', () => {
    const onChange = vi.fn();
    render(<MASourceSelect value="close" onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } });
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('shows Korean label for close option', () => {
    render(<MASourceSelect value="close" onChange={() => {}} />);
    expect(screen.getByText('종가')).toBeTruthy();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LineWidthSelect from './LineWidthSelect';

describe('LineWidthSelect', () => {
  it('renders 4 width options', () => {
    render(<LineWidthSelect value={1} onChange={() => {}} />);
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(4);
    expect(opts.map((o) => o.getAttribute('value'))).toEqual(['1', '2', '3', '4']);
  });

  it('displays current width', () => {
    render(<LineWidthSelect value={3} onChange={() => {}} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('3');
  });

  it('emits numeric value to onChange', () => {
    const onChange = vi.fn();
    render(<LineWidthSelect value={1} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith(2);
  });
});

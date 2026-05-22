import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import TimeframeSelector from './TimeframeSelector';

describe('TimeframeSelector', () => {
  it('renders all 6 timeframe buttons', () => {
    render(<TimeframeSelector value="1m" onChange={() => {}} />);
    for (const tf of ['1m', '3m', '5m', '10m', '15m', '30m']) {
      expect(screen.getByRole('button', { name: tf })).toBeInTheDocument();
    }
  });

  it('marks the active button with aria-pressed=true', () => {
    render(<TimeframeSelector value="5m" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '5m' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1m' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onChange when an inactive button is clicked', () => {
    const onChange = vi.fn();
    render(<TimeframeSelector value="1m" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '5m' }));
    expect(onChange).toHaveBeenCalledWith('5m');
  });

  it('does not call onChange when the active button is clicked', () => {
    const onChange = vi.fn();
    render(<TimeframeSelector value="1m" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '1m' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

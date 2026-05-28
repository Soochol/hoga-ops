import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ColorSwatchButton, { MA_PALETTE } from './ColorSwatchButton';

describe('ColorSwatchButton', () => {
  it('renders a button showing the current color', () => {
    render(<ColorSwatchButton value="#EC4899" onChange={() => {}} />);
    const btn = screen.getByRole('button', { name: 'MA 색상 선택' });
    expect(btn.style.backgroundColor).toMatch(/236.*72.*153|#ec4899/i);
  });

  it('opens palette popover on click', () => {
    render(<ColorSwatchButton value="#EC4899" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 색상 선택' }));
    // After open, palette options appear.
    const palette = screen.getAllByRole('button', { name: /MA 색상 후보/ });
    expect(palette).toHaveLength(MA_PALETTE.length);
  });

  it('emits selected hex via onChange and closes popover', () => {
    const onChange = vi.fn();
    render(<ColorSwatchButton value="#EC4899" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 색상 선택' }));
    const options = screen.getAllByRole('button', { name: /MA 색상 후보/ });
    fireEvent.click(options[2]);
    expect(onChange).toHaveBeenCalledWith(MA_PALETTE[2]);
    // After selection, palette options should no longer be in the document.
    expect(screen.queryAllByRole('button', { name: /MA 색상 후보/ })).toHaveLength(0);
  });

  it('exports an 8-color MA_PALETTE matching tokens.css', () => {
    expect(MA_PALETTE).toHaveLength(8);
    expect(MA_PALETTE[0]).toBe('#EC4899');
    expect(MA_PALETTE[7]).toBe('#94A3B8');
  });
});

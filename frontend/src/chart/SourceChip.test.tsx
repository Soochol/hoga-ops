import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceChip } from './SourceChip';

describe('SourceChip', () => {
  it('renders hogaplay variant with resolution suffix', () => {
    render(<SourceChip source="hogaplay" />);
    expect(screen.getByText(/hogaplay/)).toBeInTheDocument();
    expect(screen.getByText(/tick/)).toBeInTheDocument();
  });

  it('renders kis_live variant with 10s suffix', () => {
    render(<SourceChip source="kis_live" />);
    expect(screen.getByText(/kis_live/)).toBeInTheDocument();
    expect(screen.getByText(/10s/)).toBeInTheDocument();
  });

  it('renders empty (returns null) when source is undefined', () => {
    const { container } = render(<SourceChip source={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('applies the right token-based styling per source', () => {
    const { container, rerender } = render(<SourceChip source="hogaplay" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.background).toMatch(/var\(--source-hogaplay-bg\)/);
    rerender(<SourceChip source="kis_live" />);
    const chip2 = container.firstChild as HTMLElement;
    expect(chip2.style.background).toMatch(/var\(--source-kis-live-bg\)/);
  });
});

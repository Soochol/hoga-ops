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
    expect(screen.getByText('KIS WS')).toBeInTheDocument();
    expect(screen.getByText(/10s/)).toBeInTheDocument();
  });

  it('renders kis_api variant with 30s suffix', () => {
    render(<SourceChip source="kis_api" />);
    expect(screen.getByText('KIS API')).toBeInTheDocument();
    expect(screen.getByText(/30s/)).toBeInTheDocument();
  });

  it('renders screener_daily variant with 1D suffix', () => {
    render(<SourceChip source="screener_daily" />);
    expect(screen.getByText('스크리너')).toBeInTheDocument();
    expect(screen.getByText(/1D/)).toBeInTheDocument();
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
    rerender(<SourceChip source="kis_api" />);
    const chip3 = container.firstChild as HTMLElement;
    expect(chip3.style.background).toMatch(/var\(--source-kis-api-bg\)/);
    rerender(<SourceChip source="screener_daily" />);
    const chip4 = container.firstChild as HTMLElement;
    expect(chip4.style.background).toMatch(/var\(--source-screener-daily-bg\)/);
  });
});

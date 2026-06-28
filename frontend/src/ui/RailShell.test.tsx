import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  RailButton,
  RailDrawer,
  RailDrawerBody,
  RailDrawerHeader,
  RailDrawerSection,
  RailState,
} from './RailShell';

describe('RailShell primitives', () => {
  it('renders a token-backed drawer surface', () => {
    render(<RailDrawer id="panel" testId="panel">body</RailDrawer>);
    const drawer = screen.getByTestId('panel');
    expect(drawer).toHaveClass('h-full');
    expect(drawer).toHaveClass('bg-bg-card');
    expect(drawer).toHaveStyle({ width: 'var(--watchlist-panel-w)' });
  });

  it('renders drawer header, section, and body wrappers', () => {
    render(
      <RailDrawer id="panel">
        <RailDrawerHeader title="스크리너" />
        <RailDrawerSection>controls</RailDrawerSection>
        <RailDrawerBody>rows</RailDrawerBody>
      </RailDrawer>,
    );
    expect(screen.getByText('스크리너')).toHaveClass('uppercase');
    expect(screen.getByText('controls')).toHaveClass('border-b');
    expect(screen.getByText('rows')).toHaveClass('overflow-auto');
  });

  it('renders rail buttons with active state', () => {
    render(<RailButton active aria-label="관심">관심</RailButton>);
    const button = screen.getByRole('button', { name: '관심' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveClass('bg-tint-selection');
  });

  it('renders drawer states by tone', () => {
    render(
      <>
        <RailState>empty</RailState>
        <RailState tone="error">failed</RailState>
        <RailState tone="warn">warning</RailState>
      </>,
    );
    expect(screen.getByText('empty')).toHaveClass('text-fg-dim');
    expect(screen.getByText('failed')).toHaveClass('text-error');
    expect(screen.getByText('warning')).toHaveStyle({ color: 'var(--warn)' });
  });
});

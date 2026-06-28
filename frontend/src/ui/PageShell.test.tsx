import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ControlBar,
  DefinitionRow,
  PageState,
  PanelCard,
  SegmentedControl,
  ToolbarButton,
} from './PageShell';

describe('PageShell primitives', () => {
  it('renders a token-backed panel card and merges caller classes', () => {
    render(<PanelCard className="min-h-0">body</PanelCard>);
    const panel = screen.getByText('body');
    expect(panel).toHaveClass('bg-bg-card');
    expect(panel).toHaveClass('border');
    expect(panel).toHaveClass('border-border');
    expect(panel).toHaveClass('rounded-lg');
    expect(panel).toHaveClass('shadow-[0_18px_60px_rgba(0,0,0,0.22)]');
    expect(panel).toHaveClass('min-h-0');
  });

  it('can render PanelCard as a section', () => {
    render(<PanelCard as="section">section body</PanelCard>);
    expect(screen.getByText('section body').tagName).toBe('SECTION');
  });

  it('renders control bars and toolbar button tones', () => {
    render(
      <ControlBar>
        <ToolbarButton>Cancel</ToolbarButton>
        <ToolbarButton tone="primary">Run</ToolbarButton>
        <ToolbarButton tone="destructive">Delete</ToolbarButton>
      </ControlBar>,
    );
    expect(screen.getByText('Cancel').parentElement).toHaveClass('flex');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('bg-bg-input');
    expect(screen.getByRole('button', { name: 'Run' })).toHaveClass('bg-accent');
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveStyle({ background: 'var(--error)' });
  });

  it('renders a segmented control with an accessible group label', () => {
    render(
      <SegmentedControl aria-label="정렬">
        <button type="button">A</button>
      </SegmentedControl>,
    );
    expect(screen.getByRole('group', { name: '정렬' })).toHaveClass('bg-bg-input');
  });

  it('renders page states by tone', () => {
    render(
      <>
        <PageState>empty</PageState>
        <PageState tone="error">failed</PageState>
        <PageState tone="warn">warning</PageState>
      </>,
    );
    expect(screen.getByText('empty')).toHaveClass('text-fg-dim');
    expect(screen.getByText('failed')).toHaveClass('text-error');
    expect(screen.getByText('warning')).toHaveStyle({ color: 'var(--warn)' });
  });

  it('renders Settings-style definition rows', () => {
    render(<DefinitionRow label="API URL" value="http://test" />);
    expect(screen.getByText('API URL')).toHaveClass('uppercase');
    expect(screen.getByText('http://test')).toHaveClass('font-mono');
  });
});

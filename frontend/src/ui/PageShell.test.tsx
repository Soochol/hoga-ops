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
    expect(panel).toHaveClass('shadow-panel');
    expect(panel).toHaveClass('min-h-0');
  });

  it('drops the border under `borderless` (부유 카드 모델, /heatmap)', () => {
    render(<PanelCard borderless>floating</PanelCard>);
    const panel = screen.getByText('floating');
    // 테두리는 빠지되 나머지 카드 크롬(bg-card + shadow-panel + radius)은 유지 — live 패널과 동형.
    expect(panel).not.toHaveClass('border');
    expect(panel).not.toHaveClass('border-border');
    expect(panel).toHaveClass('bg-bg-card');
    expect(panel).toHaveClass('shadow-panel');
    expect(panel).toHaveClass('rounded-lg');
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
    // secondary는 테두리 없는 ghost(2026-07-15) — 투명 배경.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('bg-transparent');
    expect(screen.getByRole('button', { name: 'Run' })).toHaveClass('bg-accent');
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveStyle({ background: 'var(--error)' });
  });

  it('renders a segmented control with an accessible group label', () => {
    render(
      <SegmentedControl aria-label="정렬">
        <button type="button">A</button>
      </SegmentedControl>,
    );
    // 테두리 없는 세그먼트(2026-07-15) — bg-subtle 트랙.
    expect(screen.getByRole('group', { name: '정렬' })).toHaveClass('bg-bg-subtle');
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

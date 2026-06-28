import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DropOverlay,
  IconToolbarButton,
  WorkspaceHeader,
  WorkspaceRoot,
  WorkspaceState,
  WorkspaceToolbar,
} from './WorkspaceShell';

describe('WorkspaceShell primitives', () => {
  it('renders a full-bleed workspace root', () => {
    render(<WorkspaceRoot testId="root">body</WorkspaceRoot>);
    const root = screen.getByTestId('root');
    expect(root).toHaveClass('h-full');
    expect(root).toHaveClass('bg-bg');
    expect(root).toHaveClass('text-fg');
  });

  it('renders token-backed header and toolbar rows', () => {
    render(
      <>
        <WorkspaceHeader testId="header">header</WorkspaceHeader>
        <WorkspaceToolbar testId="toolbar">toolbar</WorkspaceToolbar>
      </>,
    );
    expect(screen.getByTestId('header')).toHaveClass('border-b');
    expect(screen.getByTestId('header')).toHaveClass('backdrop-blur');
    expect(screen.getByTestId('header')).toHaveStyle({ height: 'var(--h-live-header)' });
    expect(screen.getByTestId('toolbar')).toHaveClass('border-b');
    expect(screen.getByTestId('toolbar')).toHaveClass('backdrop-blur');
    expect(screen.getByTestId('toolbar')).toHaveClass('overflow-x-auto');
    expect(screen.getByTestId('toolbar')).toHaveStyle({ height: 'var(--h-toolbar)' });
  });

  it('renders shared icon toolbar buttons', () => {
    render(<IconToolbarButton aria-label="설정">설정</IconToolbarButton>);
    const button = screen.getByRole('button', { name: '설정' });
    expect(button).toHaveClass('bg-bg-input');
    expect(button).toHaveClass('border-border-strong');
    expect(button).toHaveClass('text-fg-dim');
  });

  it('renders centered workspace state and optional drop overlay', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <WorkspaceState testId="state" dropTargetRef={ref} showDropOverlay>
        비어 있음
      </WorkspaceState>,
    );
    expect(screen.getByTestId('state')).toHaveClass('h-full');
    expect(screen.getByText('비어 있음')).toHaveClass('text-fg-dimmer');
    expect(screen.getByText('여기에 놓아 학습뷰 열기')).toBeInTheDocument();
  });

  it('renders a reusable drop overlay label', () => {
    render(<DropOverlay>드롭</DropOverlay>);
    expect(screen.getByText('드롭')).toHaveClass('font-semibold');
  });
});

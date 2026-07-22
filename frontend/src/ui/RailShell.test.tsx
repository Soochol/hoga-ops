import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  RailButton,
  RailDrawer,
  RailDrawerBody,
  RailDrawerHeader,
  RailDrawerSection,
  RailGroupHeader,
  RailState,
  RailToolbarIconButton,
  RailTreeRow,
} from './RailShell';

describe('RailShell primitives', () => {
  it('renders a token-backed drawer surface', () => {
    render(<RailDrawer id="panel" testId="panel">body</RailDrawer>);
    const drawer = screen.getByTestId('panel');
    expect(drawer).toHaveClass('h-full');
    // 경계선 없는 크롬 표면(2026-07-22 구분선 최소화 C안) — 분리는 bg-subtle 톤이 담당.
    expect(drawer).not.toHaveClass('border-l');
    expect(drawer).toHaveClass('bg-bg-subtle');
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
    expect(screen.getByText('controls')).not.toHaveClass('border-b');
    expect(screen.getByText('rows')).toHaveClass('overflow-auto');
  });

  it('renders rail buttons with active state', () => {
    render(<RailButton active aria-label="관심">관심</RailButton>);
    const button = screen.getByRole('button', { name: '관심' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveClass('bg-tint-selection');
    expect(button).toHaveClass('border-l-2');
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

  it('renders drawer tree toolbar buttons, group headers, and tree rows', () => {
    render(
      <>
        <RailToolbarIconButton active aria-label="전체 접기">C</RailToolbarIconButton>
        <RailGroupHeader
          aria-label="삼성전자 005930 접기"
          aria-expanded="true"
          leading={<span>▼</span>}
          count={2}
        >
          삼성전자
        </RailGroupHeader>
        <RailTreeRow role="button" tabIndex={0}>급등 이후</RailTreeRow>
      </>,
    );

    expect(screen.getByRole('button', { name: '전체 접기' })).toHaveClass('h-7');
    expect(screen.getByRole('button', { name: '전체 접기' })).toHaveClass('bg-bg-input');
    expect(screen.getByRole('button', { name: '삼성전자 005930 접기' })).toHaveClass('sticky');
    expect(screen.getByText('2')).toHaveClass('text-fg-dimmer');
    expect(screen.getByText('급등 이후')).toHaveClass('pl-10');
  });
});

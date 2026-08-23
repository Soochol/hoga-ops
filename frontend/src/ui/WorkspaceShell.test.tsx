import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IconToolbarButton, WorkspaceToolbar } from './WorkspaceShell';

/**
 * ⚠ 여기 있던 케이스 셋(`WorkspaceRoot` · `WorkspaceHeader` · `WorkspaceState`+`DropOverlay`)은
 * 2026-08-23 에 **그 컴포넌트들과 함께** 사라졌다. 넷 다 `/study` 만 쓰던 프리미티브였고
 * (`WorkspaceState` 는 문구가 아예 「여기에 놓아 학습뷰 열기」였다), 페이지가 지워지자
 * 소비처가 0 이 됐다. 남은 둘은 `/live` 툴바가 쓴다.
 */

describe('WorkspaceShell primitives', () => {
  it('renders the token-backed toolbar row', () => {
    render(<WorkspaceToolbar testId="toolbar">toolbar</WorkspaceToolbar>);
    // 2026-07-23 통일: 툴바 하단 구분선 제거 — 선 없이 톤만.
    expect(screen.getByTestId('toolbar')).not.toHaveClass('border-b');
    expect(screen.getByTestId('toolbar')).toHaveClass('backdrop-blur');
    expect(screen.getByTestId('toolbar')).toHaveClass('overflow-x-auto');
    expect(screen.getByTestId('toolbar')).toHaveStyle({ height: 'var(--h-toolbar)' });
  });

  it('renders shared icon toolbar buttons', () => {
    // #633: 툴바 버튼은 ghost(투명 배경·무테두리) — hover에서만 배경이 생긴다.
    render(<IconToolbarButton aria-label="설정">설정</IconToolbarButton>);
    const button = screen.getByRole('button', { name: '설정' });
    expect(button).toHaveClass('bg-transparent');
    expect(button).toHaveClass('hover:bg-bg-input-hover');
    expect(button).toHaveClass('text-fg-dim');
  });

});

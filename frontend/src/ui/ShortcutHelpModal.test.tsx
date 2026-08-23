import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ShortcutHelpHost } from './ShortcutHelpModal';
import { openShortcutHelp } from './shortcutHelp';

function renderHost(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutHelpHost />
    </MemoryRouter>,
  );
}

describe('ShortcutHelpHost', () => {
  beforeEach(() => cleanup());

  it('opens on "?" and shows the live sections on /live', async () => {
    renderHost('/live');
    expect(screen.queryByRole('dialog', { name: '단축키 도움말' })).toBeNull();
    fireEvent.keyDown(window, { key: '?', shiftKey: true });
    expect(screen.getByRole('dialog', { name: '단축키 도움말' })).toBeInTheDocument();
    expect(screen.getByText('관심종목 다음/이전 종목')).toBeInTheDocument();
    // 그리기 섹션은 tools.ts 를 지연 로드해 채운다(수평선 등 spec 라벨).
    expect(await screen.findByText('수평선')).toBeInTheDocument();
    // 다시 '?' → 토글 닫힘.
    fireEvent.keyDown(window, { key: '?', shiftKey: true });
    expect(screen.queryByRole('dialog', { name: '단축키 도움말' })).toBeNull();
  });

  // `/study` 섹션 케이스가 여기 있었다(2026-08-23 제거) — 그 페이지의 탭 단축키
  // 도움말인데, 탭은 ADR-0149 로 먼저 사라졌고 페이지가 뒤따랐다.
  it('채널로 열린다 — 라우트 전용 섹션이 없는 곳에서도', () => {
    renderHost('/inventory');
    act(() => openShortcutHelp());
    expect(screen.getByRole('dialog', { name: '단축키 도움말' })).toBeInTheDocument();
    expect(screen.queryByText('관심종목 다음/이전 종목')).toBeNull();
  });

  it('ignores "?" typed inside an input', () => {
    renderHost('/live');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: '?', shiftKey: true });
    expect(screen.queryByRole('dialog', { name: '단축키 도움말' })).toBeNull();
    input.remove();
  });
});

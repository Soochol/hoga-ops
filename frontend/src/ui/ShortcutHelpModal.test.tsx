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

  it('shows the study section on /study and opens via the channel', () => {
    renderHost('/study');
    act(() => openShortcutHelp());
    expect(screen.getByText('탭 선택')).toBeInTheDocument();
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

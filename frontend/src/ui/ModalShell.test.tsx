import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModalShell } from './ModalShell';

describe('ModalShell', () => {
  it('renders children and (with title) a 닫기 header button', () => {
    render(<ModalShell ariaLabel="설정" title="차트 설정" onClose={vi.fn()}><p>body</p></ModalShell>);
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(screen.getByText('차트 설정')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '닫기' })).toBeInTheDocument();
  });
  it('renders no header when title is omitted', () => {
    render(<ModalShell ariaLabel="확인" onClose={vi.fn()}><p>body</p></ModalShell>);
    expect(screen.queryByRole('button', { name: '닫기' })).not.toBeInTheDocument();
  });
  it('closes on backdrop mousedown but not on inner press', () => {
    // click 이 아니라 mousedown 기준(useDismissablePopover 관례) — 카드 안 드래그가
    // 백드롭에서 끝나도 닫히지 않게 하는 계약의 절반.
    const onClose = vi.fn();
    render(<ModalShell ariaLabel="확인" onClose={onClose}><button type="button">inner</button></ModalShell>);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'inner' }));
    fireEvent.click(screen.getByRole('button', { name: 'inner' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('drag started inside the card and released on the backdrop does not close', () => {
    // 카드 안 텍스트 선택 드래그 → 백드롭에서 mouseup 하면 click 이 공통 조상
    // (백드롭)에서 발화한다 — click 기반이던 시절의 오작동 시나리오.
    const onClose = vi.fn();
    render(<ModalShell ariaLabel="확인" onClose={onClose}><button type="button">inner</button></ModalShell>);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'inner' }));
    fireEvent.mouseUp(screen.getByRole('dialog'));
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('focuses the first focusable on open and restores focus on close', () => {
    const outside = document.createElement('button');
    outside.textContent = 'opener';
    document.body.appendChild(outside);
    outside.focus();

    const { unmount } = render(
      <ModalShell ariaLabel="확인" onClose={vi.fn()}><button type="button">inner</button></ModalShell>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'inner' }));
    unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('traps Tab within the card (wraps at both ends)', () => {
    render(
      <ModalShell ariaLabel="확인" title="제목" onClose={vi.fn()}>
        <button type="button">first</button>
        <button type="button">last</button>
      </ModalShell>,
    );
    const dialog = screen.getByRole('dialog');
    const closeBtn = screen.getByRole('button', { name: '닫기' });
    const last = screen.getByRole('button', { name: 'last' });

    // 끝에서 Tab → 처음(헤더 ✕)으로 순환.
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);
    // 처음에서 Shift+Tab → 끝으로 순환.
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ModalShell ariaLabel="확인" onClose={onClose}><p>body</p></ModalShell>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('side="right" renders a right-anchored drawer (lighter dim, border-l)', () => {
    render(
      <ModalShell ariaLabel="지표" side="right" onClose={vi.fn()}>
        <p>body</p>
      </ModalShell>,
    );
    const dialog = screen.getByRole('dialog');
    // 우측 정렬 + 가벼운 딤(차트가 뒤로 보이도록).
    expect(dialog).toHaveClass('justify-end');
    expect(dialog).toHaveClass('bg-black/30');
    // 카드는 좌측 보더의 전체 높이 드로어.
    const card = screen.getByText('body').parentElement!;
    expect(card).toHaveClass('border-l');
    expect(card).toHaveClass('h-full');
  });
  it('center variant keeps the classic centered card', () => {
    render(<ModalShell ariaLabel="확인" onClose={vi.fn()}><p>body</p></ModalShell>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('justify-center');
    expect(dialog).toHaveClass('bg-black/50');
  });
});

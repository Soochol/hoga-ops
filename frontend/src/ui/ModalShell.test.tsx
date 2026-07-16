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
  it('closes on backdrop click but not on inner click', () => {
    const onClose = vi.fn();
    render(<ModalShell ariaLabel="확인" onClose={onClose}><button type="button">inner</button></ModalShell>);
    fireEvent.click(screen.getByRole('button', { name: 'inner' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
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

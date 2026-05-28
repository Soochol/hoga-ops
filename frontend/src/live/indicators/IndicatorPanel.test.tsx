import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import IndicatorPanel from './IndicatorPanel';

describe('IndicatorPanel', () => {
  it('lists 7 categories with 이동평균선 as the only active one', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    const buttons = screen.getAllByRole('button', { name: /이동평균선|일목균형표|볼린저밴드|슈퍼트렌드|매물대분석|엔벨로프|윌리엄스/ });
    expect(buttons).toHaveLength(7);
    // 6 of them are disabled.
    expect(buttons.filter((b) => (b as HTMLButtonElement).disabled)).toHaveLength(6);
    // 이동평균선 is active.
    expect((screen.getByRole('button', { name: '이동평균선' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders MovingAverageConfig in the right pane', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    expect(screen.getByText('지난 n일 동안 주가 평균값을 이은 선')).toBeTruthy();
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<IndicatorPanel onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('✕ button calls onClose', () => {
    const onClose = vi.fn();
    render(<IndicatorPanel onClose={onClose} />);
    // Two "닫기" buttons exist: header ✕ (aria-label) and footer text button.
    // Both wire to onClose — clicking either verifies the wire-up.
    const closeBtns = screen.getAllByRole('button', { name: '닫기' });
    expect(closeBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(closeBtns[0]);
    expect(onClose).toHaveBeenCalled();
  });

  it('backdrop click calls onClose, inside click does not', () => {
    const onClose = vi.fn();
    render(<IndicatorPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    // "이동평균선" appears both as a nav button label and as the MA config h3.
    // The nav button is the first occurrence; click its parent for an inside-content check.
    const navLabel = screen.getAllByText('이동평균선')[0];
    fireEvent.click(navLabel.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

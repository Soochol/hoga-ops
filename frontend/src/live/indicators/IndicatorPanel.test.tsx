import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import IndicatorPanel from './IndicatorPanel';

describe('IndicatorPanel', () => {
  it('lists 10 category checkboxes with MA/거래량/외국인/기관 active', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(10);
    // 6 placeholders remain disabled (indicators not yet supported).
    expect(checkboxes.filter((c) => (c as HTMLButtonElement).disabled)).toHaveLength(6);
    // 이동평균선 is enabled and checked by default.
    const ma = screen.getByRole('checkbox', { name: '이동평균선' }) as HTMLButtonElement;
    expect(ma.disabled).toBe(false);
    expect(ma.getAttribute('aria-checked')).toBe('true');
    // Investor toggles are enabled but off by default (opt-in).
    const fn = screen.getByRole('checkbox', { name: '외국인 순매수량' }) as HTMLButtonElement;
    expect(fn.disabled).toBe(false);
    expect(fn.getAttribute('aria-checked')).toBe('false');
  });

  it('clicking 외국인 순매수량 toggles foreignNetEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ foreignNetEnabled: false });
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '외국인 순매수량' }));
    expect(useLivePageStore.getState().foreignNetEnabled).toBe(true);
  });

  it('clicking 기관 순매수량 toggles institutionNetEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ institutionNetEnabled: false });
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '기관 순매수량' }));
    expect(useLivePageStore.getState().institutionNetEnabled).toBe(true);
  });

  it('clicking 거래량 toggles volumeEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ volumeEnabled: true });
    render(<IndicatorPanel onClose={() => {}} />);
    const vol = screen.getByRole('checkbox', { name: '거래량' }) as HTMLButtonElement;
    // 거래량은 active 카테고리 — 기본 켜짐(default true), 클릭하면 토글.
    expect(vol.disabled).toBe(false);
    fireEvent.click(vol);
    expect(useLivePageStore.getState().volumeEnabled).toBe(false);
    fireEvent.click(vol);
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('clicking 이동평균선 checkbox toggles movingAverageEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ movingAverageEnabled: true });
    render(<IndicatorPanel onClose={() => {}} />);
    const ma = screen.getByRole('checkbox', { name: '이동평균선' });
    fireEvent.click(ma);
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(false);
    fireEvent.click(ma);
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(true);
  });

  it('renders MovingAverageConfig in the right pane', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    expect(screen.getByText('지난 n일 동안 주가 평균값을 이은 선')).toBeTruthy();
  });

  it('clicking a category label navigates the right pane to that indicator detail', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    // Default detail is 이동평균선.
    expect(screen.getByText(/지난 n일 동안/)).toBeTruthy();

    // 거래량 → 거래량 detail (MA detail gone). The label is a button; the
    // on/off control is the separate role=checkbox icon.
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    expect(screen.getByText(/거래량을 막대로/)).toBeTruthy();
    expect(screen.queryByText(/지난 n일 동안/)).toBeNull();

    // 외국인 순매수량 → its detail.
    fireEvent.click(screen.getByRole('button', { name: '외국인 순매수량' }));
    expect(screen.getByText(/외국인.*순매수 수량/)).toBeTruthy();

    // 기관 순매수량 → its detail.
    fireEvent.click(screen.getByRole('button', { name: '기관 순매수량' }));
    expect(screen.getByText(/기관.*순매수 수량/)).toBeTruthy();
  });

  it('navigating to a category does NOT toggle its master switch', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ volumeEnabled: true });
    render(<IndicatorPanel onClose={() => {}} />);
    // Clicking the label navigates only — the checkbox is the toggle.
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
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

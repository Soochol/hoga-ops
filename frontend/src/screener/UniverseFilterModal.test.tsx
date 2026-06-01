import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ScreenerUniverse } from '../api/screener';
import { UniverseFilterModal } from './UniverseFilterModal';

const mount = (universe: ScreenerUniverse = {}) => {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(<UniverseFilterModal universe={universe} onChange={onChange} onClose={onClose} />);
  return { onChange, onClose };
};

describe('UniverseFilterModal', () => {
  it('기본은 시장 그룹 — KOSPI/KOSDAQ 보이고 제외 체크박스는 안 보임', () => {
    mount();
    expect(screen.getByRole('dialog', { name: '사전필터' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'KOSPI' })).toBeInTheDocument();
    expect(screen.queryByLabelText('ETF 제외')).not.toBeInTheDocument();
  });

  it('제외 그룹으로 pane 전환', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '제외' }));
    expect(screen.getByLabelText('ETF 제외')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'KOSPI' })).not.toBeInTheDocument();
  });

  it('ETF 제외 토글 → onChange 즉시 호출', () => {
    const { onChange } = mount({});
    fireEvent.click(screen.getByRole('button', { name: '제외' }));
    fireEvent.click(screen.getByLabelText('ETF 제외'));
    expect(onChange).toHaveBeenCalledWith({ exclude_etf: true });
  });

  it('시장 토글 → onChange 에 markets 갱신', () => {
    const { onChange } = mount({});
    fireEvent.click(screen.getByRole('button', { name: 'KOSDAQ' }));
    expect(onChange).toHaveBeenCalledWith({ markets: ['KOSDAQ'] });
  });

  it('푸터 닫기 클릭 → onClose', () => {
    const { onClose } = mount();
    const closers = screen.getAllByRole('button', { name: '닫기' });  // 헤더 ✕ + 푸터 닫기
    fireEvent.click(closers[closers.length - 1]);                      // 푸터 닫기
    expect(onClose).toHaveBeenCalled();
  });

  it('제외 활성이면 제외 nav 행이 data-active=true', () => {
    mount({ exclude_halted: true });
    expect(screen.getByRole('button', { name: '제외' })).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('button', { name: '시장' })).toHaveAttribute('data-active', 'false');
  });

  it('마지막 시장 토글 해제 → markets undefined 로 정규화', () => {
    const { onChange } = mount({ markets: ['KOSPI'] });
    fireEvent.click(screen.getByRole('button', { name: 'KOSPI' }));   // 유일한 선택 시장 해제
    expect(onChange).toHaveBeenCalledWith({ markets: undefined });
  });

  it('체크된 ETF 제외 해제 → exclude_etf undefined 로 정규화', () => {
    const { onChange } = mount({ exclude_etf: true });
    fireEvent.click(screen.getByRole('button', { name: '제외' }));     // 제외 pane
    fireEvent.click(screen.getByLabelText('ETF 제외'));               // 이미 체크됨 → 해제
    expect(onChange).toHaveBeenCalledWith({ exclude_etf: undefined });
  });
});

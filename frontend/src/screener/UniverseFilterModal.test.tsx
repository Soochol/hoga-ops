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

  it('푸터 확인 클릭 → onClose (즉시 적용 모델이라 확인은 순수 dismiss)', () => {
    const { onChange, onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    expect(onClose).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('취소 → 연 시점 스냅샷으로 되돌리는 onChange 후 onClose', () => {
    // 모달은 토글마다 부모 universe 를 즉시 갱신하므로, 취소 시점의 prop 은 이미
    // 달라져 있다 — 리마운트로 그 상태를 재현한다(부모 리렌더 시뮬레이션).
    const onChange = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <UniverseFilterModal universe={{}} onChange={onChange} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'KOSDAQ' }));
    expect(onChange).toHaveBeenCalledWith({ markets: ['KOSDAQ'] });
    rerender(<UniverseFilterModal universe={{ markets: ['KOSDAQ'] }} onChange={onChange} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(onChange).toHaveBeenLastCalledWith({});   // 연 시점 스냅샷 복원
    expect(onClose).toHaveBeenCalled();
  });

  it('무변경 취소는 onChange 를 부르지 않는다 — dirty 플래그 오염 방지', () => {
    const { onChange, onClose } = mount({ markets: ['KOSPI'] });
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(onChange).not.toHaveBeenCalled();
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

  it('종목 범위 그룹으로 pane 전환 → 관심종목/히트맵 체크박스', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '종목 범위' }));
    expect(screen.getByLabelText('관심종목')).toBeInTheDocument();
    expect(screen.getByLabelText('히트맵 종목')).toBeInTheDocument();
  });

  it('관심종목 스코프 토글 → onChange 에 scopes 갱신', () => {
    const { onChange } = mount({});
    fireEvent.click(screen.getByRole('button', { name: '종목 범위' }));
    fireEvent.click(screen.getByLabelText('관심종목'));
    expect(onChange).toHaveBeenCalledWith({ scopes: ['watchlist'] });
  });

  it('두 번째 스코프 토글 → 합집합으로 누적', () => {
    const { onChange } = mount({ scopes: ['watchlist'] });
    fireEvent.click(screen.getByRole('button', { name: '종목 범위' }));
    fireEvent.click(screen.getByLabelText('히트맵 종목'));
    expect(onChange).toHaveBeenCalledWith({ scopes: ['watchlist', 'heatmap'] });
  });

  it('마지막 스코프 해제 → scopes undefined 로 정규화', () => {
    const { onChange } = mount({ scopes: ['heatmap'] });
    fireEvent.click(screen.getByRole('button', { name: '종목 범위' }));
    fireEvent.click(screen.getByLabelText('히트맵 종목'));   // 유일한 스코프 해제
    expect(onChange).toHaveBeenCalledWith({ scopes: undefined });
  });

  it('스코프 활성이면 종목 범위 nav 행이 data-active=true', () => {
    mount({ scopes: ['watchlist'] });
    expect(screen.getByRole('button', { name: '종목 범위' })).toHaveAttribute('data-active', 'true');
  });
});

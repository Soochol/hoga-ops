import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ScreenerUniverse } from '../api/screener';
import { UniverseFilterButton } from './UniverseFilterButton';

const mount = (universe: ScreenerUniverse = {}) => {
  const onChange = vi.fn();
  render(<UniverseFilterButton universe={universe} onChange={onChange} />);
  return { onChange };
};

describe('UniverseFilterButton', () => {
  it('활성 없음 — 배지 없이 라벨만, aria-expanded=false', () => {
    mount({});
    const btn = screen.getByRole('button', { name: '사전필터' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn.textContent).not.toMatch(/\d/);
  });

  it('활성 — 카운트 배지 + 열거형 aria-label', () => {
    mount({ markets: ['KOSPI'], exclude_etf: true });
    const btn = screen.getByRole('button', { name: '사전필터, 2개: KOSPI · ETF 제외' });
    expect(btn.textContent).toContain('2');
  });

  it('클릭 시 모달 열림, 닫기 시 닫힘', () => {
    mount({});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '사전필터' }));
    expect(screen.getByRole('dialog', { name: '사전필터' })).toBeInTheDocument();
    // 모달이 열리면 "닫기" 컨트롤이 2개(헤더 ✕ + 푸터). 푸터 닫기를 클릭.
    const closers = screen.getAllByRole('button', { name: '닫기' });
    fireEvent.click(closers[closers.length - 1]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

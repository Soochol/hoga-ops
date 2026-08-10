import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CollectionDot } from './CollectionDot';

afterEach(cleanup);

describe('CollectionDot', () => {
  it('realtime: 점만 — 라벨 텍스트 없음, aria-label로 의미', () => {
    render(<CollectionDot status="realtime" />);
    const el = screen.getByTestId('collection-dot-realtime');
    expect(el.textContent).toBe('');
    expect(el.getAttribute('aria-label')).toBe('실시간 수집 중');
  });
  it('polling: 점만 — 라벨 텍스트 없음', () => {
    render(<CollectionDot status="polling" />);
    const el = screen.getByTestId('collection-dot-polling');
    expect(el.textContent).toBe('');
    expect(screen.queryByText('준실시간')).toBeNull();
  });
  it('waiting_eod: 점만 — 라벨 텍스트 없음', () => {
    render(<CollectionDot status="waiting_eod" />);
    const el = screen.getByTestId('collection-dot-waiting_eod');
    expect(el.textContent).toBe('');
    expect(screen.queryByText('저녁대기')).toBeNull();
  });
  // ADR-0143 §5-B — 계층을 문구에 드러낸다. "재연결 중" 만으로는 REST 토스트의
  // "재시도 중" 과 구별되지 않았다(실시간 스트림 vs 과거 조회).
  it('disconnected: 점 + "실시간 재연결 중" 텍스트', () => {
    render(<CollectionDot status="disconnected" />);
    expect(screen.getByText('실시간 재연결 중')).toBeTruthy();
  });

  // 좁은 자리(관심종목 행)는 라벨을 끈다 — 라벨이 들어오면 종목명이 52 → 13px 로
  // 짜부러진다(2026-08-10 실측). 문구는 aria-label 이 그대로 전달하므로 정보는
  // 사라지지 않는다 — 그게 이 옵션이 성립하는 조건이다.
  it('showLabel=false: 글자는 숨기되 의미는 aria-label 로 남긴다', () => {
    render(<CollectionDot status="disconnected" showLabel={false} />);
    const el = screen.getByTestId('collection-dot-disconnected');

    expect(el.textContent).toBe('');
    expect(screen.queryByText('실시간 재연결 중')).toBeNull();
    expect(el.getAttribute('aria-label')).toBe('실시간 재연결 중');
    expect(el.getAttribute('title')).toBe('실시간 재연결 중');
  });
  it('uncollected: 렌더 안 함(null)', () => {
    const { container } = render(<CollectionDot status="uncollected" />);
    expect(container.firstChild).toBeNull();
  });
});

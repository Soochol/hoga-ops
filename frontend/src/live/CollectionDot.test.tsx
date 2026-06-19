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
  it('disconnected: 점 + "재연결 중" 텍스트', () => {
    render(<CollectionDot status="disconnected" />);
    expect(screen.getByText('재연결 중')).toBeTruthy();
  });
  it('uncollected: 렌더 안 함(null)', () => {
    const { container } = render(<CollectionDot status="uncollected" />);
    expect(container.firstChild).toBeNull();
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, renderHook } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { useJumpToLive } from './useJumpToLive';
import { useLivePageStore } from '../state/livePage';

// 단일 뷰 모델(ADR-0113): jump 은 page 스토어의 activeCode/activeInstrument 를 제자리
// 교체한다. 스토어는 모듈 싱글턴 + localStorage 이므로 각 테스트가 둘 다 리셋한다.
beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({
    activeInstrument: null,
    activeCode: null,
    candleTimeframe: '1m',
    historicalFromDate: null,
  });
});

function Probe() {
  const jump = useJumpToLive();
  const { pathname } = useLocation();
  return (
    <>
      <button onClick={() => jump('005930')}>jump</button>
      <span data-testid="path">{pathname}</span>
    </>
  );
}

describe('useJumpToLive', () => {
  it('sets activeCode and navigates to /live when elsewhere', async () => {
    render(
      <MemoryRouter initialEntries={['/inventory']}>
        <Probe />
        <Routes><Route path="*" element={null} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('jump'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/live'));
  });

  it('sets activeCode without changing route when already on /live', () => {
    render(
      <MemoryRouter initialEntries={['/live']}>
        <Probe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('jump'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    expect(screen.getByTestId('path').textContent).toBe('/live');
  });

  it('projects code + label onto the active view (activeInstrument carries the label)', () => {
    const { result } = renderHook(() => useJumpToLive(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>,
    });
    result.current('005930', '삼성전자');
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    expect(useLivePageStore.getState().activeInstrument).toEqual({
      kind: 'stock',
      code: '005930',
      label: '삼성전자',
    });
  });

  it('replaces the active view in place, resetting pan for the new subject', () => {
    useLivePageStore.setState({
      activeInstrument: { kind: 'stock', code: '000660', label: 'SK하이닉스' },
      activeCode: '000660',
      candleTimeframe: '5m',
      historicalFromDate: '20260101',
    });

    const { result } = renderHook(() => useJumpToLive(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>,
    });

    result.current('005930', '삼성전자');

    const state = useLivePageStore.getState();
    expect(state.activeCode).toBe('005930');
    // timeframe 유지(같은 봉으로 종목만 전환), pan 은 새 종목 기본 뷰로 초기화.
    expect(state.candleTimeframe).toBe('5m');
    expect(state.historicalFromDate).toBeNull();
  });
});

describe('useJumpToLive — ctrl/⌘+클릭 새 탭', () => {
  let open: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    open = vi.fn();
    vi.stubGlobal('open', open);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jumpAt(path: string) {
    const { result } = renderHook(() => useJumpToLive(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>,
    });
    return result;
  }

  it('ctrl+클릭은 /live?code= 를 새 탭으로 연다', () => {
    jumpAt('/live').current('005930', '삼성전자', { ctrlKey: true, metaKey: false });
    expect(open).toHaveBeenCalledWith('/live?code=005930', '_blank', 'noopener');
  });

  it('⌘+클릭도 같다(mac)', () => {
    jumpAt('/live').current('005930', '삼성전자', { ctrlKey: false, metaKey: true });
    expect(open).toHaveBeenCalledWith('/live?code=005930', '_blank', 'noopener');
  });

  it('새 탭으로 열 때 현재 뷰의 종목은 바뀌지 않는다', () => {
    useLivePageStore.setState({
      activeInstrument: { kind: 'stock', code: '000660', label: 'SK하이닉스' },
      activeCode: '000660',
    });

    jumpAt('/live').current('005930', '삼성전자', { ctrlKey: true, metaKey: false });

    expect(useLivePageStore.getState().activeCode).toBe('000660');
  });

  it('모디파이어가 없으면 종전대로 현재 뷰를 교체한다 — 새 탭 없음', () => {
    jumpAt('/live').current('005930', '삼성전자', { ctrlKey: false, metaKey: false });
    expect(open).not.toHaveBeenCalled();
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });

  it('이벤트를 아예 안 넘기는 호출부(키보드·드롭)는 영향받지 않는다', () => {
    jumpAt('/live').current('005930');
    expect(open).not.toHaveBeenCalled();
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useScreenerUpdateSync,
  useScreenerUpdateFeedback,
  finishedMessage,
  SKIP_REASON_MESSAGES,
} from './useScreenerUpdateSync';
import { useScreenerUpdate } from './useScreenerUpdate';
import { useScreenerPanelStore } from '../state/screenerPanel';
import * as screenerApi from '../api/screener';
import type { ScreenerStatus } from '../api/screener';
import type { PushEvent } from '../api/types';

const sseState = vi.hoisted(() => {
  const subs: { current: ((e: PushEvent) => void)[] } = { current: [] };
  return { subs };
});

vi.mock('../api/eventStream', () => ({
  subscribeToScreenerUpdateEvents: (cb: (e: PushEvent) => void) => {
    sseState.subs.current.push(cb);
    return () => {
      sseState.subs.current = sseState.subs.current.filter((s) => s !== cb);
    };
  },
}));

function fireEvent_(e: PushEvent) {
  act(() => { sseState.subs.current.forEach((s) => s(e)); });
}

function makeWrapper(qc: QueryClient) {
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const OK_STATUS: ScreenerStatus = {
  status: 'ok', last_raw_date: '20260626', days_behind: 1, updating: null,
};

const SCAN = {
  savedId: 's1', savedName: 'n', savedUpdatedAtMs: 1, scanKey: null,
  rows: [], scanStatus: 'ok' as const, warnings: [], depthValues: null,
  scannedAtMs: Date.now(), basis: 'intraday' as const, dataStale: false,
};

beforeEach(() => {
  sseState.subs.current = [];
  vi.restoreAllMocks();
  useScreenerUpdateFeedback.setState({ feedback: null });
  useScreenerPanelStore.setState({
    selectedSavedId: null, lastScan: null,
    updateState: { status: 'idle' }, sortMode: 'default',
  });
});

describe('useScreenerUpdateSync', () => {
  it('progress 이벤트가 screener-status 캐시의 updating 을 패치한다', () => {
    const qc = new QueryClient();
    qc.setQueryData(['screener-status'], OK_STATUS);
    renderHook(() => useScreenerUpdateSync(), { wrapper: makeWrapper(qc) });

    fireEvent_({ type: 'screener_update_progress', done: 120, total: 3561 });

    const status = qc.getQueryData<ScreenerStatus>(['screener-status']);
    expect(status?.updating).toMatchObject({ done: 120, total: 3561 });
  });

  it('finished(updated>0) → 피드백 + dataStale + updateState success + invalidate', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['screener-status'], OK_STATUS);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    useScreenerPanelStore.setState({ lastScan: { ...SCAN } });
    renderHook(() => useScreenerUpdateSync(), { wrapper: makeWrapper(qc) });

    fireEvent_({ type: 'screener_update_finished', updated: 3, total: 3561, reason: null });

    expect(useScreenerUpdateFeedback.getState().feedback).toMatchObject({
      message: '3거래일 추가됨', tone: 'info',
    });
    expect(useScreenerPanelStore.getState().lastScan?.dataStale).toBe(true);
    expect(useScreenerPanelStore.getState().updateState.status).toBe('success');
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['screener-status'] }));
  });

  it('finished(reason=error) → error 피드백 + updateState error + dataStale 미마킹', () => {
    const qc = new QueryClient();
    useScreenerPanelStore.setState({ lastScan: { ...SCAN } });
    renderHook(() => useScreenerUpdateSync(), { wrapper: makeWrapper(qc) });

    fireEvent_({ type: 'screener_update_finished', updated: 0, total: 3561, reason: 'error' });

    expect(useScreenerUpdateFeedback.getState().feedback).toMatchObject({
      message: '갱신 실패', tone: 'error',
    });
    expect(useScreenerPanelStore.getState().updateState.status).toBe('error');
    expect(useScreenerPanelStore.getState().lastScan?.dataStale).toBe(false);
  });

  it('finished(updated=0, reason=null) → 추가분 없음 피드백 + dataStale 미마킹', () => {
    const qc = new QueryClient();
    useScreenerPanelStore.setState({ lastScan: { ...SCAN } });
    renderHook(() => useScreenerUpdateSync(), { wrapper: makeWrapper(qc) });

    fireEvent_({ type: 'screener_update_finished', updated: 0, total: 3561, reason: null });

    expect(useScreenerUpdateFeedback.getState().feedback).toMatchObject({
      message: '추가된 확정분 없음', tone: 'info',
    });
    expect(useScreenerPanelStore.getState().lastScan?.dataStale).toBe(false);
    expect(useScreenerPanelStore.getState().updateState.status).toBe('success');
  });

  it('disconnected → screener-status invalidate(오프라인 중 완료 복구)', () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useScreenerUpdateSync(), { wrapper: makeWrapper(qc) });

    fireEvent_({ type: 'disconnected' });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['screener-status'] });
  });
});

describe('finishedMessage', () => {
  it('cancelled → warn 톤 갱신 중단됨', () => {
    expect(finishedMessage({ updated: 0, reason: 'cancelled' })).toMatchObject({
      message: '갱신 중단됨', tone: 'warn',
    });
  });
});

describe('useScreenerUpdate (mutation)', () => {
  it('no_gap 응답 → 이미 최신입니다 피드백, 캐시 updating 불변', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['screener-status'], OK_STATUS);
    vi.spyOn(screenerApi, 'triggerScreenerUpdate')
      .mockResolvedValue({ running: false, updated: 0, reason: 'no_gap' });
    const { result } = renderHook(() => useScreenerUpdate(), { wrapper: makeWrapper(qc) });

    act(() => result.current.mutate());

    await waitFor(() => expect(useScreenerUpdateFeedback.getState().feedback).toMatchObject({
      message: SKIP_REASON_MESSAGES.no_gap, tone: 'info',
    }));
    expect(qc.getQueryData<ScreenerStatus>(['screener-status'])?.updating).toBeNull();
  });

  it('running 응답 → 캐시에 updating 낙관 패치(첫 WS 이벤트 전 표시)', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['screener-status'], OK_STATUS);
    vi.spyOn(screenerApi, 'triggerScreenerUpdate')
      .mockResolvedValue({ running: true, done: 0, total: 3561 });
    const { result } = renderHook(() => useScreenerUpdate(), { wrapper: makeWrapper(qc) });

    act(() => result.current.mutate());

    await waitFor(() => expect(
      qc.getQueryData<ScreenerStatus>(['screener-status'])?.updating,
    ).toMatchObject({ done: 0, total: 3561 }));
  });
});

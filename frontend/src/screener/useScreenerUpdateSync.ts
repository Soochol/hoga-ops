import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { subscribeToScreenerUpdateEvents } from '../api/eventStream';
import type { ScreenerStatus, ScreenerUpdateSkipReason } from '../api/screener';
import { useScreenerPanelStore } from '../state/screenerPanel';

export interface ScreenerUpdateFeedback {
  message: string;
  tone: 'info' | 'warn' | 'error';
  atMs: number;
}

/** 갱신 결과의 일회성 피드백 — 페이지·드로어가 공유(비영속, 다음 갱신 시 clear). */
export const useScreenerUpdateFeedback = create<{
  feedback: ScreenerUpdateFeedback | null;
  setFeedback: (f: ScreenerUpdateFeedback) => void;
  clear: () => void;
}>((set) => ({
  feedback: null,
  setFeedback: (f) => set({ feedback: f }),
  clear: () => set({ feedback: null }),
}));

export const SKIP_REASON_MESSAGES: Record<ScreenerUpdateSkipReason, string> = {
  no_gap: '이미 최신입니다',
  not_seeded: '시드되지 않음 — 운영자 CLI로 시드하세요',
  kis_creds_missing: 'KIS 인증정보 없음 — 갱신 불가',
  calendar_unavailable: '거래일 조회 불가 — 잠시 후 다시 시도하세요',
};

export function finishedMessage(e: { updated: number; reason: string | null }): ScreenerUpdateFeedback {
  const atMs = Date.now();
  if (e.reason === 'error') return { message: '갱신 실패', tone: 'error', atMs };
  if (e.reason === 'cancelled') return { message: '갱신 중단됨', tone: 'warn', atMs };
  if (e.updated > 0) return { message: `${e.updated}거래일 추가됨`, tone: 'info', atMs };
  return { message: '추가된 확정분 없음', tone: 'info', atMs };
}

/**
 * 스크리너 갱신 job 의 WS 이벤트를 ['screener-status'] 캐시에 반영하는 단일
 * 구독자 — App 루트에 정확히 1회 마운트(useCaptureQueueSync 선례). 진행은
 * status.updating 패치로 페이지·드로어에 동시 전파되고, 완료는 피드백 스토어 +
 * 드로어 상태머신 settle + status invalidate(서버가 updating 을 지운 진실 재조회).
 */
export function useScreenerUpdateSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribeToScreenerUpdateEvents((e) => {
      if (e.type === 'screener_update_progress') {
        qc.setQueryData<ScreenerStatus>(['screener-status'], (prev) =>
          prev
            ? {
                ...prev,
                updating: {
                  done: e.done,
                  total: e.total,
                  started_ms: prev.updating?.started_ms ?? Date.now(),
                },
              }
            : prev);
      } else if (e.type === 'screener_update_finished') {
        useScreenerUpdateFeedback.getState().setFeedback(finishedMessage(e));
        const panel = useScreenerPanelStore.getState();
        if (e.updated > 0) panel.markLastScanDataStale();
        if (e.reason === 'error') panel.setUpdateError('갱신 실패', Date.now());
        else panel.setUpdateSuccess(Date.now());
        qc.invalidateQueries({ queryKey: ['screener-status'] });
      } else if (e.type === 'disconnected') {
        // WS 드롭 중 완료된 갱신이 진행바를 박제하지 않도록 서버 진실 재조회.
        qc.invalidateQueries({ queryKey: ['screener-status'] });
      }
    });
  }, [qc]);
}

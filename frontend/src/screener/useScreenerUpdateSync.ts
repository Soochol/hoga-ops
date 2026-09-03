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
  /**
   * 이 메시지를 낳은 사건. **스토어가 두 종류를 나른다** — 갱신 결과와, 갱신과 무관한
   * 모니터링 자동 종료 알림(`ScreenerDrawer` 의 `onAutoStop`)이다.
   *
   * 이 구분이 없으면 "갱신 중에는 지난 결과를 감춘다" 를 구현할 때 무관한 모니터링
   * 알림까지 함께 삼킨다 — 그건 조회 반복 실패를 알리는 유일한 표면이다.
   */
  source: 'update' | 'monitor';
}

/** 갱신 결과의 일회성 피드백 — 페이지·드로어가 공유(비영속, 다음 갱신 시 clear). */
export const useScreenerUpdateFeedback = create<{
  feedback: ScreenerUpdateFeedback | null;
  setFeedback: (f: ScreenerUpdateFeedback) => void;
  clear: () => void;
  clearUpdateResult: () => void;
}>((set) => ({
  feedback: null,
  setFeedback: (f) => set({ feedback: f }),
  clear: () => set({ feedback: null }),
  /** 새 실행이 시작됐다 — 지난 **갱신 결과만** 버린다(모니터링 알림은 남긴다). */
  clearUpdateResult: () => set((s) => (s.feedback?.source === 'update' ? { feedback: null } : {})),
}));

/**
 * 화면에 실제로 그릴 피드백. **저장값을 그대로 그리면 거짓말을 한다** — 갱신이 도는
 * 동안 남아 있는 「지난 실행의 결과」가 진행 표시 바로 옆에 붙는다(2026-09-03 신고:
 * "갱신 중 874/4,335" 옆에 "갱신 실패").
 *
 * **감추기만 하고 지우지 않는다.** 실행이 끝나면 `screener_update_finished` 가 새 값을
 * 덮으므로 마지막 결과는 늘 보인다 — 여기서 지워 버리면 그 이벤트를 놓쳤을 때 표면이
 * 빈다. 낡은 값을 실제로 버리는 것은 `clearUpdateResult` 의 몫이다(둘은 서로 다른
 * 실패 경로를 막는다: 이쪽은 WS 드롭 뒤 REST 로 `updating` 만 되살아난 경우, 저쪽은
 * `finished` 를 놓친 경우).
 *
 * `source` 로 좁히는 이유: 스토어가 모니터링 자동 종료 알림도 나르는데 그건 갱신과
 * 무관하므로 갱신 중에도 계속 보여야 한다.
 */
export function visibleUpdateFeedback(
  feedback: ScreenerUpdateFeedback | null,
  isUpdating: boolean,
): ScreenerUpdateFeedback | null {
  if (feedback === null) return null;
  return isUpdating && feedback.source === 'update' ? null : feedback;
}

export const SKIP_REASON_MESSAGES: Record<ScreenerUpdateSkipReason, string> = {
  no_gap: '이미 최신입니다',
  not_seeded: '시드되지 않음 — 운영자 CLI로 시드하세요',
  creds_missing: '키움 인증정보 없음 — 갱신 불가',
  // **재시도 안내를 달지 않는다.** 달력 조회 경로에는 벤더가 없어(PR-H·#1044)
  // "일시 장애" 라는 사건 자체가 없다 — 아래 둘 다 사람이 뭔가 고쳐야 풀린다.
  calendar_source_missing: '거래일 달력 소스를 읽을 수 없음 — 배포·서버 로그를 확인하세요',
  calendar_coverage_behind: '거래일 달력이 오늘까지 밀리지 않음 — 스케줄러를 확인하세요',
};

export function finishedMessage(e: { updated: number; reason: string | null }): ScreenerUpdateFeedback {
  const atMs = Date.now();
  const source = 'update' as const;
  if (e.reason === 'error') return { message: '갱신 실패', tone: 'error', atMs, source };
  if (e.reason === 'cancelled') return { message: '갱신 중단됨', tone: 'warn', atMs, source };
  if (e.updated > 0) return { message: `${e.updated}거래일 추가됨`, tone: 'info', atMs, source };
  return { message: '추가된 확정분 없음', tone: 'info', atMs, source };
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
        // 진행이 왔다 = **새 실행이 돌고 있다** → 지난 결과는 이 시점에 이미 낡았다.
        // `useScreenerUpdate` 의 `onMutate` clear 로는 부족하다 — 그건 이 탭에서
        // 버튼을 누른 경우만 타고, 스케줄러·다른 창이 시작한 실행은 안 지나간다.
        useScreenerUpdateFeedback.getState().clearUpdateResult();
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
        if (e.updated > 0) useScreenerPanelStore.getState().markLastScanDataStale();
        qc.invalidateQueries({ queryKey: ['screener-status'] });
      } else if (e.type === 'disconnected') {
        // WS 드롭 중 완료된 갱신이 진행바를 박제하지 않도록 서버 진실 재조회.
        qc.invalidateQueries({ queryKey: ['screener-status'] });
      }
    });
  }, [qc]);
}

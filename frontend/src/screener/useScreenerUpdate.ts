import { useMutation, useQueryClient } from '@tanstack/react-query';
import { triggerScreenerUpdate, type ScreenerStatus } from '../api/screener';
import { SKIP_REASON_MESSAGES, useScreenerUpdateFeedback } from './useScreenerUpdateSync';

/** 데이터 갱신 mutation — 서버-소유 job 을 스폰하고 즉시 돌아온다. 진행·완료는
 *  WS 이벤트(useScreenerUpdateSync)와 status.updating 이 전달하고, 여기서는
 *  running 응답을 캐시에 낙관 반영(첫 이벤트 전 버튼 비활성)하거나 no-op skip
 *  reason 을 피드백으로 표면화한다. /screener 페이지와 드로어가 공유하는 단일 출처. */
export function useScreenerUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => triggerScreenerUpdate(),
    onMutate: () => useScreenerUpdateFeedback.getState().clear(),
    onSuccess: (res) => {
      if (res.running) {
        queryClient.setQueryData<ScreenerStatus>(['screener-status'], (prev) =>
          prev
            ? { ...prev, updating: { done: res.done, total: res.total, started_ms: Date.now() } }
            : prev);
      } else {
        useScreenerUpdateFeedback.getState().setFeedback({
          message: SKIP_REASON_MESSAGES[res.reason],
          tone: res.reason === 'no_gap' ? 'info' : 'warn',
          atMs: Date.now(),
        });
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['screener-status'] }),
  });
}

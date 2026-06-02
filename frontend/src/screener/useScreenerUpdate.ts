import { useMutation, useQueryClient } from '@tanstack/react-query';
import { triggerScreenerUpdate } from '../api/screener';

/** 데이터 갱신 mutation — 성공·실패 모두 freshness 칩(screener-status)을 무효화해
 *  결과를 반영하고, 실패는 호출부가 isError 로 표면화한다. /screener 페이지와
 *  Screener 패널(드로어)이 공유하는 단일 출처(가드/표시는 서피스별). */
export function useScreenerUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => triggerScreenerUpdate(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['screener-status'] }),
  });
}

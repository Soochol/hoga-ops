import { useEffect, useRef, useState } from 'react';
import type { AskPeak } from '../api/types';
import type { ObSnapshot } from './bucketHogaSeries';
import { foldAskPeak, FRESH_RATCHET, type RatchetState } from './computeDayAskPeak';

/** 당일 매도 최대벽 ratchet. LivePage에서 **1회** 호출(기존 live.ob 재사용 —
 *  useLiveSeries를 다시 부르지 않아 2차 SSE 연결을 만들지 않는다).
 *  ob: SSE 버퍼(≤15분, ref가 틱마다 바뀜). seed: bundle.ask_peak. */
export function useDayAskPeak(
  ob: ReadonlyArray<ObSnapshot>,
  seed: AskPeak | null,
  code: string | null,
): AskPeak | null {
  const stateRef = useRef<RatchetState>(FRESH_RATCHET);
  const [peak, setPeak] = useState<AskPeak | null>(seed);

  // code 변경 → 리셋·재시드(remount 비의존).
  useEffect(() => {
    stateRef.current = FRESH_RATCHET;
    setPeak(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // ob 틱마다 증분 fold(lastTMs 가드로 본 것은 건너뜀). seed 변동도 반영.
  useEffect(() => {
    let s = stateRef.current;
    for (const snap of ob) s = foldAskPeak(s, seed, snap);
    stateRef.current = s;
    setPeak(s.peak ?? seed);
  }, [ob, seed]);

  return peak;
}

import { useEffect, useRef, useState } from 'react';
import type { AskPeak } from '../api/types';
import type { ObSnapshot } from './bucketHogaSeries';
import { reduceDayAskPeak, FRESH_RATCHET, type RatchetState } from './computeDayAskPeak';

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

  // ob 틱마다 당일 매도 최대벽 규칙(루프 + seed 하한)을 reduceDayAskPeak에 위임 — 그 순수
  // 모듈이 규칙을 소유하고, 훅은 ratchet 상태를 ref에 들고 구동만 한다(얇은 adapter).
  useEffect(() => {
    const s = reduceDayAskPeak(stateRef.current, seed, ob);
    stateRef.current = s;
    setPeak(s.peak ?? seed);
  }, [ob, seed]);

  return peak;
}

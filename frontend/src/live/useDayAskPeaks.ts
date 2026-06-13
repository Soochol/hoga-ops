import { useEffect, useMemo, useRef, useState } from 'react';
import type { AskPeak } from '../api/types';
import type { ObSnapshot } from './bucketHogaSeries';
import {
  reduceDayAskPeak,
  FRESH_RATCHET,
  type DayPeak,
  type RatchetState,
} from './computeDayAskPeak';

/** 거래일별 매도 최대벽 리스트. LivePage에서 **1회** 호출(기존 live.ob 재사용 — useLiveSeries를
 *  다시 부르지 않아 2차 SSE 연결을 만들지 않는다).
 *
 *  - 과거일 항목(seed의 date != todayKst)은 백엔드 값 그대로 통과(불변).
 *  - 오늘 항목(date == todayKst)만 live.ob로 단조 ratchet 갱신(seed=오늘 백엔드 값).
 *  반환은 그날 segment 구간에 수평선으로 그릴 per-day AskPeak 배열. */
export function useDayAskPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  code: string | null,
): AskPeak[] {
  // 오늘 seed(있으면) — ratchet의 시드. AskPeak은 구조적으로 DayPeak이라 그대로 넘긴다.
  const todaySeed: DayPeak | null = useMemo(
    () => seeds.find((p) => p.date === todayKst) ?? null,
    [seeds, todayKst],
  );

  const stateRef = useRef<RatchetState>(FRESH_RATCHET);
  const [todayPeak, setTodayPeak] = useState<DayPeak | null>(todaySeed);

  // 종목 전환 → ratchet 리셋·재시드(remount 비의존).
  useEffect(() => {
    stateRef.current = FRESH_RATCHET;
    setTodayPeak(todaySeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // ob 틱마다 오늘 ratchet 전진(루프+seed 하한은 reduceDayAskPeak이 소유). seed 변동도 반영.
  useEffect(() => {
    const s = reduceDayAskPeak(stateRef.current, todaySeed, ob);
    stateRef.current = s;
    setTodayPeak(s.peak ?? todaySeed);
  }, [ob, todaySeed]);

  // 과거일 seed(그대로) + 오늘 ratchet 결과(date 부착)를 합친 per-day 리스트.
  return useMemo(() => {
    const out: AskPeak[] = seeds.filter((p) => p.date !== todayKst);
    if (todayPeak) {
      out.push({ date: todayKst, price: todayPeak.price, qty: todayPeak.qty, t_ms: todayPeak.t_ms });
    }
    return out;
  }, [seeds, todayKst, todayPeak]);
}

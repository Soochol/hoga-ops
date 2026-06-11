import { create } from 'zustand';
import { unixMsToKSTDate } from '../util/time';

/** since-open 시계열 누적 store. 풀 리로드(인메모리)·KST 날짜롤오버에 리셋된다 —
 *  "보드를 연 이후"에 가까운 롤링 동작(spec 2026-06-11 §4). cap=롤링 최근 MAX_POINTS점
 *  (=10초폴×40≈6.7분): 개장 후 cap분까지는 글자그대로 since-open, 이후 트레일링 창.
 *  점수는 QA 튜닝 대상(spec §Risks). 진짜 풀 since-open은 서버 옵션 b(Out-of-Scope). */
export const MAX_POINTS = 40;

export interface SparkPoint { code: string; value: number | null; }

interface Store {
  series: Map<string, number[]>;
  /** 마지막 append의 KST yyyymmdd. 롤오버 판정용. */
  lastDate: string | null;
  /** 한 폴의 전 종목 값을 일괄 append. nowMs로 KST 날짜 판정(롤오버 시 clear).
   *  새 Map을 이번 배치 코드들로만 구성 → watchlist에서 빠진 코드는 자연 prune.
   *  value===null(일시적 결측)이면 carry-forward(점 안 늘리고 기존 시계열 보존). */
  appendBatch: (points: SparkPoint[], nowMs: number) => void;
  reset: () => void;
}

export const useSparklineStore = create<Store>((set, get) => ({
  series: new Map(),
  lastDate: null,
  appendBatch: (points, nowMs) => {
    const date = unixMsToKSTDate(nowMs);
    const prev = get();
    const rollover = prev.lastDate !== null && prev.lastDate !== date;
    const base = rollover ? new Map<string, number[]>() : prev.series;
    const next = new Map<string, number[]>();
    for (const { code, value } of points) {
      const arr = base.get(code) ?? [];
      if (value === null) {
        // carry-forward: 이번 폴에 값 결측이어도 기존 시계열을 보존(점은 안 늘림).
        // 빈 배열은 set하지 않아 Map 오염을 막는다(rollover/첫 폴 결측). watchlist에
        // 남아 있으면 보존되고, 배치에서 빠진 코드만 prune된다(아래 next 미포함).
        if (arr.length > 0) next.set(code, arr);
        continue;
      }
      const grown = arr.length >= MAX_POINTS
        ? [...arr.slice(arr.length - MAX_POINTS + 1), value]
        : [...arr, value];
      next.set(code, grown);
    }
    set({ series: next, lastDate: date });
  },
  reset: () => set({ series: new Map(), lastDate: null }),
}));

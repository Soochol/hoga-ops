import { useSyncExternalStore } from 'react';
import type { RangeBundle } from '../../api/types';

/**
 * 포커스 차트 창 → 상태바 발행 채널 (ADR-0119 C2c-2c, studySaveSource 패턴).
 *
 * 플립 후 파이프라인은 각 창 안(useLiveChartData)에서 돌고 LivePage 는 셸이라,
 * LiveStatusBar 가 받던 파이프라인 산출물(bundle·체결가·확장중·호가갭)을 포커스
 * 차트 창이 여기로 발행하고 셸이 구독한다. 발행자는 항상 하나(포커스 창) —
 * 포커스 이동 시 새 창의 발행이 교체하고, blur/언마운트 시 자기 발행만 걷는다.
 */
export type LiveWindowStatus = {
  windowId: string;
  /** LiveStatusBar 의 activeCode 계약과 동일 — 주식=코드, 지수=`index:ID`. */
  workareaCode: string | null;
  bundle: RangeBundle | null;
  liveTradePrice: number | null;
  isExtending: boolean;
  /** 좌측 팬 딥 백필의 창 from-date — 상태바 "과거 로딩 중" 칩 게이트(리뷰 #1).
   *  전역 historicalFromDate 는 플립 후 항상 null 이라(미러가 null 투영), 창의
   *  런타임 값을 발행해야 칩이 뜬다. null = fresh 뷰(칩 미표시). */
  historicalFromDate: string | null;
  hogaGapDates: readonly string[];
};

let current: LiveWindowStatus | null = null;
const listeners = new Set<() => void>();

export function publishLiveWindowStatus(next: LiveWindowStatus): void {
  current = next;
  listeners.forEach((l) => l());
}

/** 자기 발행일 때만 걷는다 — 포커스 교체 직후 이전 창의 cleanup 이 새 발행을
 *  지우지 않게(studySaveSource clear 와 동일 규율). */
export function clearLiveWindowStatus(windowId: string): void {
  if (current?.windowId !== windowId) return;
  current = null;
  listeners.forEach((l) => l());
}

export function useLiveWindowStatus(): LiveWindowStatus | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}

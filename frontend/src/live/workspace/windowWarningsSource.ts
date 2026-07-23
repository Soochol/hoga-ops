import { useSyncExternalStore } from 'react';

/**
 * 창 → 타이틀바 경고 발행 채널 (종목 식별을 창 헤더/레전드→타이틀바로 이관).
 *
 * 타이틀바(WindowFrame)는 창 데이터 파이프라인(`useLiveChartData`, ChartWindowInner)
 * 의 **부모**라 `d.hogaCoverageGapDates`·백필 날짜 같은 번들 파생값에 직접 접근할 수
 * 없다. ChartWindowInner 가 이 값들을 여기로 발행하고, 타이틀바의 종목 식별 행이
 * `windowId` 로 구독한다. 현재가·등락률·히트맵은 `code` 만으로 전역 캐시 훅에서
 * self-fetch 되므로 이 채널에 싣지 않는다 — 경고 데이터만 올려 발행 빈도를 낮춘다.
 *
 * `windowId` keyed Map 이라 여러 창이 동시에 자기 타이틀바를 갱신한다(단일 포커스
 * 창만 발행하던 #865 의 liveWindowStatusSource 와 다른 점).
 */
export type WindowWarnings = {
  /** 캔들은 있는데 10호가 캡처가 없는 과거 거래일 — warn 칩. */
  hogaGapDates: readonly string[];
  /** 좌측 팬 딥 백필로 로드된 최고(最古) 거래일(YYYYMMDD). null 이면 진행 칩 미표시. */
  backfillEarliestDate: string | null;
};

/** 미발행 창의 안정 기본값 — useSyncExternalStore 가 매 렌더 같은 참조를 받게
 *  한다(새 객체 반환 시 무한 렌더). */
const EMPTY: WindowWarnings = { hogaGapDates: [], backfillEarliestDate: null };

const byWindow = new Map<string, WindowWarnings>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

export function publishWindowWarnings(windowId: string, next: WindowWarnings): void {
  byWindow.set(windowId, next);
  notify();
}

/** 자기 발행일 때만 걷는다 — 언마운트/대상 이탈 시. */
export function clearWindowWarnings(windowId: string): void {
  if (!byWindow.has(windowId)) return;
  byWindow.delete(windowId);
  notify();
}

export function useWindowWarnings(windowId: string): WindowWarnings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => byWindow.get(windowId) ?? EMPTY,
    () => EMPTY,
  );
}

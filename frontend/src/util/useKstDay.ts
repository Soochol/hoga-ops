import { useSyncExternalStore } from 'react';
import { unixMsToKSTDate } from './time';

// 모든 차트/데이터 창이 쓰는 거래일 시계. 날짜가 바뀔 때만 React가 갱신되며,
// WS가 없는 자정에도 전날 공유 버퍼가 다음 날로 넘어가지 않는다.
const DAY_MS = 24 * 60 * 60_000;
const KST_OFFSET_MS = 9 * 60 * 60_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function readDay(): string {
  return unixMsToKSTDate(Date.now());
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(refresh, DAY_MS - ((Date.now() + KST_OFFSET_MS) % DAY_MS) + 10);
}

function refresh(): void {
  for (const listener of listeners) listener();
  if (listeners.size) schedule();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    schedule();
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('pageshow', refresh);
    }
  };
}

export function useKstDay(): string {
  return useSyncExternalStore(subscribe, readDay, readDay);
}

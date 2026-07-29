import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { signalAlertRecentKey, type SignalAlertEvent, type SignalAlertRecentResponse } from '../api/signalAlerts';
import type { PushEvent } from '../api/types';
import { subscribeEvents } from '../api/ws';
import { useSignalAlertInboxStore } from '../state/signalAlertInbox';

/** WS 누적 인박스의 상한. **REST 의 `limit=100` 과 같은 값**이라는 게 요점이다
 *  (`fetchSignalAlertsRecent`). 그래야 "WS 로 자란 인박스"와 "새로고침 후 REST 로
 *  받은 인박스"가 같은 크기 계약을 갖는다 — 상한이 사용자에게 보이는 차이를 만들지
 *  않는다. 종전엔 REST 만 100 이고 WS 누적은 무제한이라 비대칭이었고, 알림이 잦은
 *  날 배열이 계속 자라며 아래 중복 검사(`alerts.some`)의 O(n) 스캔까지 같이 무거워졌다. */
const SIGNAL_ALERT_INBOX_CAP = 100;

/** 최근 본 알림 id 의 상한. 이 Set 은 캐시 교체·날짜 롤오버를 건너뛰고 "이미 셌던
 *  알림"을 기억해 미읽음 중복 집계를 막는 용도라, **최근 것만** 있으면 충분하다.
 *  종전엔 add 만 있고 지우는 경로가 없어 세션이 길수록 단조 증가했다. */
const SEEN_IDS_CAP = 500;

const seenSignalAlertIds = new Set<string>();

/** Set 은 삽입 순서를 보존하므로 순회 앞쪽이 가장 오래된 id 다. */
function noteSeenSignalAlertId(id: string): void {
  seenSignalAlertIds.add(id);
  for (const oldest of seenSignalAlertIds) {
    if (seenSignalAlertIds.size <= SEEN_IDS_CAP) break;
    seenSignalAlertIds.delete(oldest);
  }
}

function isSignalAlert(event: PushEvent): event is SignalAlertEvent {
  return event.type === 'signal_alert';
}

export function useSignalAlertEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return subscribeEvents((event) => {
      if (!isSignalAlert(event)) return;

      const isFirstSeen = !seenSignalAlertIds.has(event.id);
      const key = signalAlertRecentKey(event.date);
      let shouldCountUnread = false;

      queryClient.setQueryData<SignalAlertRecentResponse>(key, (cached) => {
        if (!cached) {
          shouldCountUnread = isFirstSeen;
          return {
            date: event.date,
            scope: 'inbox',
            cleared_through_seq: 0,
            alerts: [event],
          };
        }

        if (event.seq <= cached.cleared_through_seq) return cached;
        if (cached.alerts.some((alert) => alert.id === event.id)) return cached;
        shouldCountUnread = isFirstSeen;
        return {
          ...cached,
          alerts: [event, ...cached.alerts].slice(0, SIGNAL_ALERT_INBOX_CAP),
        };
      });

      if (isFirstSeen) noteSeenSignalAlertId(event.id);
      if (shouldCountUnread) useSignalAlertInboxStore.getState().noteIncoming(event);
    });
  }, [queryClient]);
}

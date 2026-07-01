import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  signalAlertRecentKey,
  useClearSignalAlertToday,
  useSignalAlertRecent,
  type SignalAlertEvent,
} from '../api/signalAlerts';
import { useJumpToLive } from '../live/useJumpToLive';
import { useSignalAlertInboxStore } from '../state/signalAlertInbox';
import {
  RailDrawer,
  RailDrawerBody,
  RailDrawerHeader,
  RailDrawerSection,
  RailState,
  RailToolbarIconButton,
} from '../ui/RailShell';

function todayKst(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(Date.now());
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  return `${year}${month}${day}`;
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(ms);
}

function formatSignalLine(alert: SignalAlertEvent): string {
  return `매도 총잔량 ${alert.value.toLocaleString()} · 기준 대비 ${alert.ratio_pct.toFixed(1)}%`;
}

export default function SignalAlertsDrawer({ today = todayKst() }: { today?: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useSignalAlertRecent(today);
  const clearToday = useClearSignalAlertToday(today);
  const markPanelSeen = useSignalAlertInboxStore((state) => state.markPanelSeen);
  const resetForClear = useSignalAlertInboxStore((state) => state.resetForClear);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearedLocally, setClearedLocally] = useState(false);
  const alerts = useMemo(() => data?.alerts ?? [], [data?.alerts]);
  const visibleAlerts = clearedLocally ? [] : alerts;

  useEffect(() => {
    markPanelSeen();
  }, [markPanelSeen]);

  useEffect(() => {
    setClearedLocally(false);
  }, [today]);

  useEffect(() => {
    if (alerts.length > 0) setClearedLocally(false);
  }, [alerts.length]);

  const clearVisibleInbox = () => {
    clearToday.mutate(undefined, {
      onSuccess: () => {
        resetForClear(today);
        setClearedLocally(true);
        queryClient.setQueryData(signalAlertRecentKey(today), {
          date: today,
          scope: 'inbox',
          cleared_through_seq: data?.cleared_through_seq ?? 0,
          alerts: [],
        });
        setConfirmingClear(false);
      },
    });
  };

  return (
    <RailDrawer
      id="right-rail-signal-alerts-panel"
      testId="signal-alerts-drawer"
      ariaLabel="시그널 알림"
    >
      <RailDrawerHeader
        title="시그널 알림"
        actions={(
          <RailToolbarIconButton
            aria-label="오늘 인박스 비우기"
            disabled={visibleAlerts.length === 0 || clearToday.isPending}
            onClick={() => setConfirmingClear((open) => !open)}
          >
            ×
          </RailToolbarIconButton>
        )}
      />
      <RailDrawerSection className="py-2 text-xs text-fg-dim">
        오늘 {visibleAlerts.length.toLocaleString()}건
      </RailDrawerSection>
      {confirmingClear && (
        <RailDrawerSection className="flex flex-col gap-2 text-sm">
          <p className="text-fg">오늘 표시 중인 알림 인박스를 비웁니다. 날짜별 기록은 그대로 남습니다.</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded border border-line px-2 py-1 text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg"
              onClick={() => setConfirmingClear(false)}
            >
              취소
            </button>
            <button
              type="button"
              aria-label="비우기 확인"
              className="rounded border border-line-strong px-2 py-1 text-sm text-fg hover:bg-bg-input"
              onClick={clearVisibleInbox}
            >
              비우기
            </button>
          </div>
        </RailDrawerSection>
      )}
      <RailDrawerBody>
        {isLoading && <RailState>불러오는 중…</RailState>}
        {isError && <RailState tone="error">알림 내역을 불러오지 못했습니다.</RailState>}
        {!isLoading && !isError && visibleAlerts.length === 0 && <RailState>오늘 알림이 없습니다.</RailState>}
        {!isLoading && !isError && visibleAlerts.length > 0 && (
          <ul className="divide-y divide-border">
            {visibleAlerts.map((alert) => (
              <SignalAlertRow key={alert.id} alert={alert} />
            ))}
          </ul>
        )}
      </RailDrawerBody>
    </RailDrawer>
  );
}

function SignalAlertRow({ alert }: { alert: SignalAlertEvent }) {
  const jumpToLive = useJumpToLive();
  const markPanelSeen = useSignalAlertInboxStore((state) => state.markPanelSeen);

  return (
    <li>
      <button
        type="button"
        aria-label={`${alert.name} ${alert.code} 차트 열기`}
        className="flex w-full flex-col gap-1 px-md py-sm text-left hover:bg-bg-input-hover"
        onClick={() => {
          markPanelSeen();
          jumpToLive(alert.code, alert.name);
        }}
      >
        <div className="flex items-center gap-2 text-sm text-fg">
          <span className="shrink-0 tabular-nums text-xs text-fg-dimmer">{formatTime(alert.t_ms)}</span>
          <span className="min-w-0 truncate">{alert.name}</span>
          <span className="shrink-0 text-xs text-fg-dimmer">{alert.code}</span>
        </div>
        <div className="text-xs text-fg-dim">{formatSignalLine(alert)}</div>
      </button>
    </li>
  );
}

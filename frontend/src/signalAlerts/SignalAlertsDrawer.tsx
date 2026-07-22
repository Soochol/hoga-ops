import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  signalAlertRecentKey,
  useClearSignalAlertToday,
  useSignalAlertRecent,
  type SignalAlertRecentResponse,
} from '../api/signalAlerts';
import { useJumpToLive } from '../live/useJumpToLive';
import { TrashIcon } from '../ui/TrashIcon';
import { groupSignalAlertsByCode, type SignalAlertGroup } from './groupAlerts';
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

/** 기준 대비 % 의 강조 단계 — 갱신 강도(=매도벽 크기)에 비례해 색·굵기를 준다.
 *  ≥120% 강한 갱신은 매도 방향색(파랑, KRX)으로 굵게; 그 사이는 중립; ~100 근처
 *  경미한 갱신은 dim. 균일하던 리스트에서 큰 신호만 튀게 하는 예외-기반 강조. */
function ratioEmphasisClass(pct: number): string {
  if (pct >= 120) return 'text-price-down font-semibold';
  if (pct >= 110) return 'text-fg';
  return 'text-fg-dim';
}

export default function SignalAlertsDrawer({ today = todayKst() }: { today?: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useSignalAlertRecent(today);
  const clearToday = useClearSignalAlertToday(today);
  const markPanelSeen = useSignalAlertInboxStore((state) => state.markPanelSeen);
  const resetForClear = useSignalAlertInboxStore((state) => state.resetForClear);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const alerts = useMemo(() => data?.alerts ?? [], [data?.alerts]);
  const visibleAlerts = alerts;
  // 같은 종목 반복 발화(매도벽 갱신)를 한 행으로 접어 최신순으로 — 개별 타임스탬프
  // 대신 갱신 횟수(count)·최고 강도(peakRatioPct)로 종목별 압력을 보여준다.
  const groups = useMemo(() => groupSignalAlertsByCode(visibleAlerts), [visibleAlerts]);

  useEffect(() => {
    markPanelSeen();
  }, [markPanelSeen]);

  const clearVisibleInbox = () => {
    clearToday.mutate(undefined, {
      onSuccess: (result) => {
        resetForClear(today);
        queryClient.setQueryData<SignalAlertRecentResponse>(signalAlertRecentKey(today), (current) => {
          if (!current) return current;
          return {
            ...current,
            cleared_through_seq: result.cleared_through_seq,
            alerts: current.alerts.filter((alert) => alert.seq > result.cleared_through_seq),
          };
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
            title="오늘 인박스 비우기"
            disabled={visibleAlerts.length === 0 || clearToday.isPending}
            onClick={() => setConfirmingClear((open) => !open)}
          >
            {/* 비우기(파괴적) — 헤더의 맨 × 는 "닫기"로 오독돼, 휴지통 아이콘으로
                의미를 명확히(패널 닫기는 레일 토글이 담당). */}
            <TrashIcon className="h-3.5 w-3.5" />
          </RailToolbarIconButton>
        )}
      />
      <RailDrawerSection className="py-2 text-xs text-fg-dim">
        오늘 {visibleAlerts.length.toLocaleString()}건
        {groups.length > 0 && ` · ${groups.length.toLocaleString()}종목`}
      </RailDrawerSection>
      {confirmingClear && (
        <RailDrawerSection className="flex flex-col gap-2 text-sm">
          <p className="text-fg">오늘 표시 중인 알림 인박스를 비웁니다. 날짜별 기록은 그대로 남습니다.</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg"
              onClick={() => setConfirmingClear(false)}
            >
              취소
            </button>
            <button
              type="button"
              aria-label="비우기 확인"
              className="rounded border border-border-strong px-2 py-1 text-sm text-fg hover:bg-bg-input"
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
        {!isLoading && !isError && groups.length === 0 && <RailState>오늘 알림이 없습니다.</RailState>}
        {!isLoading && !isError && groups.length > 0 && (
          <ul className="divide-y divide-border">
            {groups.map((group) => (
              <SignalAlertRow key={group.key} group={group} />
            ))}
          </ul>
        )}
      </RailDrawerBody>
    </RailDrawer>
  );
}

function SignalAlertRow({ group }: { group: SignalAlertGroup }) {
  const jumpToLive = useJumpToLive();
  const markPanelSeen = useSignalAlertInboxStore((state) => state.markPanelSeen);
  const repeated = group.count > 1;

  return (
    <li>
      <button
        type="button"
        aria-label={`${group.name} ${group.code}${repeated ? ` 갱신 ${group.count}회` : ''} 기준 대비 ${group.peakRatioPct.toFixed(1)}% 차트 열기`}
        className="grid w-full grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 px-md py-sm text-left hover:bg-bg-input-hover"
        onClick={() => {
          markPanelSeen();
          jumpToLive(group.code, group.name);
        }}
      >
        {/* 좌: 시각 · 종목명 · 코드 (· ×N 반복 배지) */}
        <div className="flex min-w-0 items-center gap-2 text-sm text-fg">
          <span className="shrink-0 tabular-nums text-xs text-fg-dimmer">{formatTime(group.latestTMs)}</span>
          <span className="min-w-0 truncate">{group.name}</span>
          {repeated && (
            <span className="shrink-0 rounded-sm bg-bg-input px-1 text-badge font-data tabular-nums text-fg-dim">
              ×{group.count}
            </span>
          )}
        </div>
        {/* 우: 기준 대비 % — 헤드라인 강도(갱신 강도 비례 강조) */}
        <span className={`shrink-0 font-data tabular-nums text-sm text-right ${ratioEmphasisClass(group.peakRatioPct)}`}>
          {group.peakRatioPct.toFixed(1)}%
        </span>
        {/* 좌 아래: 매도 총잔량(최신) — 부차 정보 */}
        <div className="col-start-1 text-xs text-fg-dimmer tabular-nums">
          매도 총잔량 {group.latestValue.toLocaleString()}
        </div>
      </button>
    </li>
  );
}

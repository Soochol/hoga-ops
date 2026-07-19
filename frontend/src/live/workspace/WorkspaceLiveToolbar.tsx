/**
 * WorkspaceLiveToolbar — 워크스페이스 상단 고정 툴바 (ADR-0119 C2c-2c).
 *
 * 창 추가(+차트·+호가·+거래원·+프로그램·+투자자·+매물대)·정리(Tidy)와 기존
 * LiveToolbar 의 액션 버튼(보조지표·설정·수집·저장뷰·프리셋)을 한 행으로 통합.
 * 봉 컨트롤은 창별 소유라 여기 없다(각 차트 창 상단). 활성 그룹은 뱃지로 표시.
 * 지표/설정/수집/저장뷰의 열림 상태는 셸(LivePage 또는 프리뷰 페이지)이 소유하고
 * 콜백으로 받는다 — LiveToolbar 와 같은 계약.
 */
import type { ReactNode } from 'react';
import { IconToolbarButton, WorkspaceToolbar } from '../../ui/WorkspaceShell';
import { LiveChartActionButtons } from '../LiveToolbar';
import { LayoutPresetMenu } from '../presets/LayoutPresetMenu';
import { requestWorkspaceTidy } from './workspaceCanvasControls';
import { useCanOpenIndicatorDrawer } from './WorkspaceIndicatorDrawer';
import {
  useWorkspaceStore,
  activeGroupOf,
  type WindowKind,
} from '../../state/workspace';

const ADD_BUTTONS: ReadonlyArray<{ kind: WindowKind; label: string }> = [
  { kind: 'chart', label: '+차트' },
  { kind: 'book', label: '+호가' },
  { kind: 'broker', label: '+거래원' },
  { kind: 'program', label: '+프로그램' },
  { kind: 'investor', label: '+투자자' },
  { kind: 'vdist', label: '+매물대' },
];

type Props = {
  onOpenIndicators: () => void;
  onOpenSettings: () => void;
  /** 활성 그룹 종목이 주식일 때만 전달(지수 미지원) — LiveToolbar 계약 동일. */
  onOpenCollect?: () => void;
  studySaveControl?: ReactNode;
};

export function WorkspaceLiveToolbar({
  onOpenIndicators,
  onOpenSettings,
  onOpenCollect,
  studySaveControl,
}: Props) {
  const addWindow = useWorkspaceStore((s) => s.addWindow);
  const windowCount = useWorkspaceStore((s) => s.windows.length);
  const activeGroup = useWorkspaceStore((s) => activeGroupOf(s));
  const canOpenIndicators = useCanOpenIndicatorDrawer();

  return (
    <WorkspaceToolbar testId="workspace-live-toolbar" className="flex-nowrap">
      <span
        className="flex items-center gap-1 text-xs text-fg-dim"
        title="활성 그룹 — 검색·관심종목 클릭이 이 그룹의 종목을 교체합니다"
      >
        <span className="font-mono">{windowCount}창</span>
        <span>· 그룹</span>
        <span className="font-mono text-accent">{activeGroup}</span>
      </span>
      <span className="mx-1 h-[14px] w-px shrink-0 bg-border-strong" />
      {ADD_BUTTONS.map(({ kind, label }) => (
        <button
          key={kind}
          type="button"
          data-testid={`workspace-add-${kind}`}
          className="shrink-0 rounded bg-bg-input px-1.5 py-0.5 text-xs text-fg-dim hover:text-fg"
          onClick={() => addWindow(kind)}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        data-testid="workspace-tidy"
        className="shrink-0 rounded bg-tint-selection px-2 py-0.5 text-xs font-medium text-accent hover:brightness-110"
        onClick={requestWorkspaceTidy}
      >
        정리
      </button>
      <span className="mx-1 h-[14px] w-px shrink-0 bg-border-strong" />
      {/* 차트 창 0개면 지표 드로어는 대상이 없다(#712) — 열기를 no-op 으로 가드. */}
      <LiveChartActionButtons
        onOpenIndicators={canOpenIndicators ? onOpenIndicators : () => {}}
        onOpenSettings={onOpenSettings}
        studySaveControl={studySaveControl}
      />
      {onOpenCollect && (
        <IconToolbarButton
          data-testid="live-collect-button"
          onClick={onOpenCollect}
          aria-label="데이터 수집"
          icon={(
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" />
              <path d="m7 11 5 4.5 5-4.5" />
              <path d="M5 21h14" />
            </svg>
          )}
        >
          <span>데이터 수집</span>
        </IconToolbarButton>
      )}
      <LayoutPresetMenu />
    </WorkspaceToolbar>
  );
}

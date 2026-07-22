/**
 * WorkspaceLiveToolbar — 워크스페이스 상단 고정 툴바 (ADR-0119 C2c-2c).
 *
 * **워크스페이스와 앱의 것만 남는다.** 창 추가·정리·레이아웃 프리셋(워크스페이스
 * 관리)과 설정(앱 전역). 차트 하나에 걸리는 것 — 봉·그리기·보조지표·저장뷰·수집 —
 * 은 전부 그 차트 창의 헤더로 이관됐다(#758 및 후속). 그 결과 이 툴바에는 "어느
 * 창/그룹에 걸리나" 를 추론해야 하는 항목이 하나도 남지 않았다.
 *
 * 설정의 열림 상태는 셸(LivePage 또는 프리뷰 페이지)이 소유하고 콜백으로 받는다.
 */
import { IconToolbarButton, WorkspaceToolbar } from '../../ui/WorkspaceShell';
import { SettingsButton } from '../LiveToolbar';
import { LayoutPresetMenu } from '../presets/LayoutPresetMenu';
import { requestWorkspaceTidy } from '../../workspace/workspaceCanvasControls';
import { WindowAddMenu } from './WindowAddMenu';
import { LiveWindowListMenu } from './LiveWindowListMenu';

type Props = {
  onOpenSettings: () => void;
};

export function WorkspaceLiveToolbar({ onOpenSettings }: Props) {
  return (
    <WorkspaceToolbar testId="workspace-live-toolbar" className="flex-nowrap">
      {/* 창 목록 — 죽어 있던 "N창 · 그룹 X" 라벨의 후계. 개수만 알리던 텍스트를
          열린 창으로 점프·닫기·정리 하는 진입점으로 승격했다(개수는 트리거 뱃지가 계승). */}
      <LiveWindowListMenu />
      <span className="mx-1 h-[14px] w-px shrink-0 bg-border-strong" />
      <WindowAddMenu />
      {/* 창 추가가 단일 드롭다운으로 접히면서(A안) accent 채움이던 정리가 툴바에서 가장
          튀게 됐다 — 더 자주 쓰는 창 추가보다 강해 위계가 뒤집힌다. 나머지 액션과 같은
          ghost 로 낮춘다. tint-selection 은 이 코드베이스에서 선택·활성 상태의 표식이고
          정리는 상태 없는 일회성 액션이라 의미론상으로도 맞지 않았다. */}
      <IconToolbarButton
        data-testid="workspace-tidy"
        className="shrink-0"
        onClick={requestWorkspaceTidy}
        icon={(
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="8.5" height="16" rx="1.5" />
            <rect x="14.5" y="4" width="6.5" height="6.5" rx="1.5" />
            <rect x="14.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
          </svg>
        )}
      >
        <span>정리</span>
      </IconToolbarButton>
      <span className="mx-1 h-[14px] w-px shrink-0 bg-border-strong" />
      {/* 보조지표는 차트 창 헤더로 이관됐다(#758) — 창의 것이라 창이 연다.
          설정은 편집 값이 앱 전역(chartPrefs·저장뷰·알림·데이터소스)이라 여기
          남는다: 창 헤더에 두면 "이 창의 설정" 으로 읽히는데 실제론 앱 전체를
          바꾼다(#759 결정 1). 차트 창 0개 가드도 함께 사라졌다 — 헤더 버튼은
          차트 창에만 있으므로 "차트 창이 있어야 연다" 가 자명하게 참이다. */}
      <SettingsButton onClick={onOpenSettings} />
      <LayoutPresetMenu />
    </WorkspaceToolbar>
  );
}

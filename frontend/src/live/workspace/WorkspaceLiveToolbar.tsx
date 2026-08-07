/**
 * WorkspaceLiveToolbar — 워크스페이스 상단 고정 툴바 (ADR-0119 C2c-2c).
 *
 * **워크스페이스와 앱의 것만 남는다.** 거래소(앱 전역)·창 추가·레이아웃 프리셋
 * (워크스페이스 관리)·설정(앱 전역). 차트 하나에 걸리는 것 — 봉·그리기·보조지표·
 * 저장뷰·수집 — 은 전부 그 차트 창의 헤더로 이관됐다(#758 및 후속). 그 결과 이
 * 툴바에는 "어느 창/그룹에 걸리나" 를 추론해야 하는 항목이 하나도 남지 않았다.
 *
 * 설정의 열림 상태는 셸(LivePage 또는 프리뷰 페이지)이 소유하고 콜백으로 받는다.
 */
import { IconToolbarButton, WorkspaceToolbar } from '../../ui/WorkspaceShell';
import { LiveVenuePicker } from '../LiveVenuePicker';
import { openShortcutHelp } from '../../ui/shortcutHelp';
import { SettingsButton } from '../LiveToolbar';
import { LayoutPresetMenu } from '../presets/LayoutPresetMenu';
import { WindowAddMenu } from './WindowAddMenu';
import { LiveWindowListMenu } from './LiveWindowListMenu';
import { captureHealthPillColor } from '../captureHealthPill';
import type { CaptureHealthView } from '../liveStatusProjection';

type Props = {
  onOpenSettings: () => void;
  /** 전역 캡처 파이프라인 건강도 — 종목 무관이라 폐지된 상태바 대신 여기 소유한다
   *  (창 헤더에 두면 종목별인 듯 반복되어 노이즈). */
  captureHealth: CaptureHealthView;
};

/** 캡처 헬스 표시 — ok+healthy 는 점(●), 그 외는 라벨 pill. 상태바에서 이관. */
function CaptureHealthIndicator({ health }: { health: CaptureHealthView }) {
  if (health.showDot) {
    return (
      <span
        data-testid="capture-health-dot"
        title={health.title}
        aria-label="캡처 정상"
        className="inline-block shrink-0 rounded-full"
        style={{ width: '6px', height: '6px', background: 'var(--success)', boxShadow: '0 0 4px var(--success)' }}
      />
    );
  }
  const pill = captureHealthPillColor(health.severity);
  return (
    <span
      data-testid="capture-health-pill"
      title={health.title}
      className="font-data shrink-0 rounded px-2 py-0.5"
      style={{ background: pill.bg, border: pill.border, color: pill.fg, fontSize: 'var(--text-xs)' }}
    >
      {health.label}
    </span>
  );
}

export function WorkspaceLiveToolbar({ onOpenSettings, captureHealth }: Props) {
  return (
    <WorkspaceToolbar testId="workspace-live-toolbar" className="flex-nowrap">
      {/* 거래소 — 툴바 맨 앞. venue 는 창이 아니라 앱 전역(관심종목·히트맵·타이틀바가
          같은 값을 읽는다)이라 창 관련 항목보다 앞이다. 설정 모달의 「거래소」 라디오는
          그대로 남는다 — 그쪽은 /study 도 렌더하고 거기엔 이 툴바가 없다. */}
      <LiveVenuePicker />
      <span className="mx-1 h-[14px] w-px shrink-0 bg-border-strong" />
      {/* 창 목록 — 죽어 있던 "N창 · 그룹 X" 라벨의 후계. 개수만 알리던 텍스트를
          열린 창으로 점프·닫기 하는 진입점으로 승격했다(개수는 트리거 뱃지가 계승). */}
      <LiveWindowListMenu />
      <span className="mx-1 h-[14px] w-px shrink-0 bg-border-strong" />
      <WindowAddMenu />
      <span className="mx-1 h-[14px] w-px shrink-0 bg-border-strong" />
      {/* 보조지표는 차트 창 헤더로 이관됐다(#758) — 창의 것이라 창이 연다.
          설정은 편집 값이 앱 전역(chartPrefs·저장뷰·알림·데이터소스)이라 여기
          남는다: 창 헤더에 두면 "이 창의 설정" 으로 읽히는데 실제론 앱 전체를
          바꾼다(#759 결정 1). 차트 창 0개 가드도 함께 사라졌다 — 헤더 버튼은
          차트 창에만 있으므로 "차트 창이 있어야 연다" 가 자명하게 참이다. */}
      <SettingsButton onClick={onOpenSettings} />
      <LayoutPresetMenu />
      {/* 단축키 도움말 — `?` 키의 가시적 진입점(발견성). 도움말의 발견성을 도움말
          단축키에만 맡기면 순환이라, 텍스트 버튼 하나를 앱 크롬에 남긴다. */}
      <IconToolbarButton
        aria-label="단축키 도움말"
        title="단축키 도움말 (?)"
        onClick={openShortcutHelp}
        icon={<span aria-hidden className="inline-flex h-[14px] w-[14px] items-center justify-center rounded border border-border-strong font-data text-2xs leading-none">?</span>}
      >
        단축키
      </IconToolbarButton>
      {/* 전역 캡처 헬스 — 우측 끝에 밀어 배치(폐지된 상태바에서 이관). */}
      <span className="ml-auto flex shrink-0 items-center pl-1">
        <CaptureHealthIndicator health={captureHealth} />
      </span>
    </WorkspaceToolbar>
  );
}

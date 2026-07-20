import { snapshotWorkspace, useWorkspaceStore } from '../../state/workspace';
import { useLiveLayoutStore } from '../../state/liveLayout';
import type { LiveLayoutPresetPayload } from '../../api/liveLayoutPresets';

/**
 * 레이아웃 프리셋의 캡처·적용 (ADR-0119 PR-E, #713 §5).
 *
 * v3: 프리셋 = **워크스페이스 전체 스냅샷**(창 목록·z순서·그룹→종목). 종목을 포함
 * 한다(TradingView 레이아웃 관례). 뷰포트·비영속 런타임은 담지 않는다(§6). 적용은
 * `applyWorkspaceSnapshot` 이 raw payload 를 canonical 재정규화(readWindow 재사용)
 * 하므로 새 창 kind/지표 필드 추가에 이 파일 변경이 없다.
 */

/** 현재 워크스페이스를 프리셋 payload 로 캡처한다(v3 = 전체 스냅샷). */
export function capturePresetPayload(): LiveLayoutPresetPayload {
  return snapshotWorkspace() as unknown as LiveLayoutPresetPayload;
}

/** 프리셋 payload(워크스페이스 스냅샷)를 적용 — 창·종목·배치를 통째 복원한다.
 *  presetId 는 "마지막 적용" 기록용(우측 패널 배치는 창으로 이주해 프리셋 밖). */
export function applyPresetPayload(payload: LiveLayoutPresetPayload, presetId: string | null): void {
  useWorkspaceStore.getState().applyWorkspaceSnapshot(payload);
  useLiveLayoutStore.getState().setLastAppliedPresetId(presetId);
}

/** 기본 레이아웃 payload — "기본으로 초기화"에 사용. 빈 스냅샷을 넘기면 apply 가
 *  공장 기본 워크스페이스(defaultWindows)로 폴백한다(별도 공장값 나열 불요). */
export function defaultPresetPayload(): LiveLayoutPresetPayload {
  return { windows: [], zOrder: [], groupSymbols: {} } as unknown as LiveLayoutPresetPayload;
}

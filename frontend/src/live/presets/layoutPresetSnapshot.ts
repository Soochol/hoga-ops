import { snapshotWorkspace, useWorkspaceStore } from '../../state/workspace';
import { useLiveLayoutStore } from '../../state/liveLayout';
import type { LiveLayoutPresetPayload } from '../../api/liveLayoutPresets';

/**
 * 레이아웃 프리셋의 캡처·적용 (ADR-0119 PR-E, #713 §5).
 *
 * 프리셋 = **창 목록·z순서·배치**. 뷰포트·비영속 런타임은 담지 않는다(§6). 적용은
 * `applyWorkspaceSnapshot` 이 raw payload 를 canonical 재정규화(readWindow 재사용)
 * 하므로 새 창 kind 추가에 이 파일 변경이 없다.
 *
 * **종목은 담기지 않는다.** v3 는 그룹→종목을 함께 저장해 적용 시 교체했지만
 * (TradingView 레이아웃 관례), 배치를 바꾸려고 누른 프리셋이 보던 종목까지 갈아치우는
 * 것이 실사용에서 손해였다. 지금은 저장이 종목을 담지 않고, 적용도 종목을 읽지
 * 않는다 — 옛 v3 payload 를 적용해도 그 부분은 `applyWorkspaceSnapshot` 이 버린다.
 *
 * **지표도 담기지 않는다.** 한때 창이 설정을 소유해서 스냅샷에 딸려 왔지만(#712),
 * 지금은 앱 전역 1세트(`live.indicators.v2`)라 창에 실을 것이 없다 — 지표를 담고
 * 있던 옛 payload 를 적용해도 그 부분은 `readWindow` 가 버린다.
 */

/** 현재 워크스페이스를 프리셋 payload 로 캡처한다(창·배치만).
 *  `groupSymbols` 는 **빈 객체를 명시적으로 보낸다** — 필드 자체는 백엔드 모델이
 *  계속 반환하므로 미러로 남기되(구 프리셋 하위호환), 값은 더 이상 싣지 않는다.
 *  기존 프리셋을 덮어쓰면 거기 남아 있던 종목도 이 빈 값으로 지워진다(의도). */
export function capturePresetPayload(): LiveLayoutPresetPayload {
  const snapshot = snapshotWorkspace();
  return { windows: snapshot.windows, zOrder: snapshot.zOrder, groupSymbols: {} };
}

/** 프리셋 payload 를 적용 — 창·배치를 복원하고 **보고 있는 종목은 그대로 둔다**.
 *  presetId 는 "마지막 적용" 기록용(우측 패널 배치는 창으로 이주해 프리셋 밖). */
export function applyPresetPayload(payload: LiveLayoutPresetPayload, presetId: string | null): void {
  useWorkspaceStore.getState().applyWorkspaceSnapshot(payload);
  useLiveLayoutStore.getState().setLastAppliedPresetId(presetId);
}

/** 기본 레이아웃 payload — "기본 배치로 초기화"에 사용. 빈 스냅샷을 넘기면 apply 가
 *  공장 기본 배치(defaultWindows)로 폴백한다(별도 공장값 나열 불요). 이 경로도 종목은
 *  건드리지 않는다 — 초기화는 배치만 되돌린다. */
export function defaultPresetPayload(): LiveLayoutPresetPayload {
  return { windows: [], zOrder: [], groupSymbols: {} };
}

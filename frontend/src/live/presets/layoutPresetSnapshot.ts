import { snapshotWorkspace, useWorkspaceStore } from '../../state/workspace';
import { useLiveLayoutStore } from '../../state/liveLayout';
import {
  captureIndicatorPayloadForWindow,
  restoreIndicatorScopesFromPayload,
} from '../../state/indicatorScopeGc';
import type { LiveLayoutPresetPayload } from '../../api/liveLayoutPresets';

/**
 * 레이아웃 프리셋의 캡처·적용 (ADR-0119 PR-E, #713 §5, ADR-0159).
 *
 * 프리셋 = **창 목록·z순서·배치 + 창별 지표 세트**. 뷰포트·비영속 런타임은 담지
 * 않는다(§6). 적용은 `applyWorkspaceSnapshot` 이 raw payload 를 canonical 재정규화
 * (readWindow 재사용)하므로 새 창 kind 추가에 이 파일 변경이 없다.
 *
 * **종목은 담기지 않는다.** v3 는 그룹→종목을 함께 저장해 적용 시 교체했지만
 * (TradingView 레이아웃 관례), 배치를 바꾸려고 누른 프리셋이 보던 종목까지 갈아치우는
 * 것이 실사용에서 손해였다. 지금은 저장이 종목을 담지 않고, 적용도 종목을 읽지
 * 않는다 — 옛 v3 payload 를 적용해도 그 부분은 `applyWorkspaceSnapshot` 이 버린다.
 *
 * **지표는 담긴다**(ADR-0159 — 종목과 반대 판정이다). 지표는 "지금 보고 있는 것" 이
 * 아니라 **작업 환경**이라, 배치와 함께 움직이는 것이 프리셋의 쓸모다. 그전에는
 * 창 id 에만 매달려 있어서, 프리셋을 갈아타면 창은 돌아오는데 지표는 페이지 세트로
 * 리셋됐다(창 id 의 스코프가 스냅샷 교체 때 회수되므로).
 *
 * ⚠ **지표 내용물이 창 스냅샷(탭별 sessionStorage)에 사는 것은 아니다** — #712 의
 * 재발이 그 형태였다. 스토어의 `WorkspaceWindow` 는 여전히 지표를 모르고, 지표는
 * 여기 **캡처 시점에만** payload 에 조립된다. 적용 경로의 `readWindow` 가 화이트
 * 리스트라 payload 의 지표 키는 스토어로 들어가지 못한다 — 그 비대칭이 방어선이다.
 */

/** payload 창 원소 — 워크스페이스 창에 지표 세트를 얹은 형태. 백엔드는 이 원소를
 *  `dict[str, Any]` 로 통과시키므로(서버는 얕은 구조 검증만) 스키마 변경이 없다. */
type PresetWindow = ReturnType<typeof snapshotWorkspace>['windows'][number]
  & ReturnType<typeof captureIndicatorPayloadForWindow>;

/** 현재 워크스페이스를 프리셋 payload 로 캡처한다(창·배치 + 차트 창의 지표).
 *  `groupSymbols` 는 **빈 객체를 명시적으로 보낸다** — 필드 자체는 백엔드 모델이
 *  계속 반환하므로 미러로 남기되(구 프리셋 하위호환), 값은 더 이상 싣지 않는다.
 *  기존 프리셋을 덮어쓰면 거기 남아 있던 종목도 이 빈 값으로 지워진다(의도). */
export function capturePresetPayload(): LiveLayoutPresetPayload {
  const snapshot = snapshotWorkspace();
  const windows: PresetWindow[] = snapshot.windows.map((w) => (
    // 지표를 갖는 창은 차트뿐이다 — 데이터 창에 빈 세트를 실으면 payload 만 커지고
    // 적용 시 심을 곳도 없다(`restoreIndicatorScopesFromPayload` 가 kind 로 거른다).
    w.kind === 'chart' ? { ...w, ...captureIndicatorPayloadForWindow(w.id) } : w
  ));
  return { windows, zOrder: snapshot.zOrder, groupSymbols: {} };
}

/** 프리셋 payload 를 적용 — 창·배치·지표를 복원하고 **보고 있는 종목은 그대로 둔다**.
 *  presetId 는 "마지막 적용" 기록용(우측 패널 배치는 창으로 이주해 프리셋 밖).
 *
 *  지표 복원이 **스냅샷 적용 뒤**인 것은 계약이다 — 그 이유 둘은
 *  `restoreIndicatorScopesFromPayload` 의 도크스트링에 있다(스코프 상한·고아 방지). */
export function applyPresetPayload(payload: LiveLayoutPresetPayload, presetId: string | null): void {
  useWorkspaceStore.getState().applyWorkspaceSnapshot(payload);
  restoreIndicatorScopesFromPayload(useWorkspaceStore.getState().windows, payload.windows);
  useLiveLayoutStore.getState().setLastAppliedPresetId(presetId);
}

/** 기본 레이아웃 payload — "기본 배치로 초기화"에 사용. 빈 스냅샷을 넘기면 apply 가
 *  공장 기본 배치(defaultWindows)로 폴백한다(별도 공장값 나열 불요). 이 경로도 종목은
 *  건드리지 않는다 — 초기화는 배치만 되돌린다.
 *
 *  지표 키가 없으므로 복원도 건너뛰고, 새로 나는 공장 창들은 마운트 시드가 페이지
 *  세트로 채운다 — "초기화" 의 뜻에 맞는다. */
export function defaultPresetPayload(): LiveLayoutPresetPayload {
  return { windows: [], zOrder: [], groupSymbols: {} };
}

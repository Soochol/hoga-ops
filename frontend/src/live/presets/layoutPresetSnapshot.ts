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
 * **핀은 여부만 담긴다**(ADR-0165 — 종목 판정과 지표 판정의 사이). 핀의 "고정돼
 * 있음"은 작업 환경이라 `wasPinned: true` 로 실리고, "무엇에 고정됐나"는 종목이라
 * 실리지 않는다 — 적용이 그 창의 **적용 시점 표시 종목**으로 물질화한다
 * (`pinWindows`, 켜기 전용). 그래서 핀 복원이 화면의 종목을 바꾸는 일은 없다.
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

/** payload 창 원소 — 워크스페이스 창에 지표 세트·핀 여부를 얹은 형태. 백엔드는 이
 *  원소를 `dict[str, Any]` 로 통과시키므로(서버는 얕은 구조 검증만) 스키마 변경이 없다.
 *
 *  `wasPinned` 는 **여부만**이다(ADR-0165) — 레거시 `pinned` 키(심볼 객체)와 다른
 *  키인 것이 계약이다: `pinned` 는 적용 경로가 전량 버리는 키로 남고(종목 주입 차단,
 *  `normalizeWorkspaceSnapshot`), `wasPinned` 는 boolean 전용으로 `applyPresetPayload`
 *  가 읽어 적용 시점의 표시 종목으로 물질화한다. */
type PresetWindow = ReturnType<typeof snapshotWorkspace>['windows'][number]
  & ReturnType<typeof captureIndicatorPayloadForWindow>
  & { wasPinned?: true };

/** 현재 워크스페이스를 프리셋 payload 로 캡처한다(창·배치 + 차트 창의 지표 + 핀 여부).
 *  `groupSymbols` 는 **빈 객체를 명시적으로 보낸다** — 필드 자체는 백엔드 모델이
 *  계속 반환하므로 미러로 남기되(구 프리셋 하위호환), 값은 더 이상 싣지 않는다.
 *  기존 프리셋을 덮어쓰면 거기 남아 있던 종목도 이 빈 값으로 지워진다(의도). */
export function capturePresetPayload(): LiveLayoutPresetPayload {
  const snapshot = snapshotWorkspace();
  // 스냅샷은 핀을 벗기므로(종목 비탑재 계약) 여부는 스토어 원본에서 id 로 다시 찾는다.
  const pinnedIds = new Set(
    useWorkspaceStore.getState().windows.filter((w) => w.pinned).map((w) => w.id),
  );
  const windows: PresetWindow[] = snapshot.windows.map((w) => ({
    // 지표를 갖는 창은 차트뿐이다 — 데이터 창에 빈 세트를 실으면 payload 만 커지고
    // 적용 시 심을 곳도 없다(`restoreIndicatorScopesFromPayload` 가 kind 로 거른다).
    ...(w.kind === 'chart' ? { ...w, ...captureIndicatorPayloadForWindow(w.id) } : w),
    ...(pinnedIds.has(w.id) ? { wasPinned: true as const } : {}),
  }));
  return { windows, zOrder: snapshot.zOrder, groupSymbols: {} };
}

/** payload 에서 핀 복원 대상 창 id 를 뽑는다 — `wasPinned === true` 만 인정한다.
 *  레거시 payload 의 `pinned`(심볼 객체·truthy)가 여기로 새면 그 시절 우연히 실린
 *  핀이 물질화되므로, 키·타입 둘 다 좁게 본다. */
function pinFlaggedIds(rawWindows: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const raw of rawWindows) {
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as Record<string, unknown>;
    if (w.wasPinned === true && typeof w.id === 'string') ids.push(w.id);
  }
  return ids;
}

/** 프리셋 payload 를 적용 — 창·배치·지표·핀 여부를 복원하고 **보고 있는 종목은
 *  그대로 둔다**. presetId 는 "마지막 적용" 기록용(우측 패널 배치는 창으로 이주해
 *  프리셋 밖).
 *
 *  지표 복원·핀 물질화가 **스냅샷 적용 뒤**인 것은 계약이다 — 지표는
 *  `restoreIndicatorScopesFromPayload` 의 도크스트링(스코프 상한·고아 방지), 핀은
 *  창이 스토어에 존재해야 물질화할 대상이 있다. 핀은 **켜기 전용**이다 — 플래그
 *  없는 프리셋이 기존 핀을 풀지 않는다(`pinWindows` 도크스트링의 비대칭). */
export function applyPresetPayload(payload: LiveLayoutPresetPayload, presetId: string | null): void {
  useWorkspaceStore.getState().applyWorkspaceSnapshot(payload);
  restoreIndicatorScopesFromPayload(useWorkspaceStore.getState().windows, payload.windows);
  useWorkspaceStore.getState().pinWindows(pinFlaggedIds(payload.windows));
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

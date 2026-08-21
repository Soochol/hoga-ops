import { snapshotStudyWorkspace, useStudyWorkspaceStore } from '../../state/studyWorkspace';
import { useStudyActivePresetStore } from '../../state/studyActivePreset';
import type { StudyLayoutPresetPayload } from '../../api/studyLayoutPresets';

/**
 * `/study` 레이아웃 프리셋의 캡처·적용.
 *
 * 캡처(`snapshotStudyWorkspace`)와 적용(`applySnapshot`)은 둘 다 이미 스토어에 있었다 —
 * "왕복 대비" 로 만들어 둔 자리를 그대로 쓴다. 여기 있는 건 활성 프리셋 id 를 함께
 * 갱신하는 배선뿐이다.
 *
 * 프리셋은 **창 배치만** 담는다 — `/live` 가 `groupSymbols` 를 빼는 것과 같은 규율이고,
 * `/study` 도 ADR-0152 로 그룹이 생기면서 같은 문제를 갖게 됐다. 창의 그룹 **번호**는
 * 배치의 일부라 payload 에 남지만 그 번호가 **어느 저장뷰인지**(`groupViews`)는 빠진다.
 * 안 그러면 배치를 불러오는 것만으로 보고 있던 복기뷰가 통째로 바뀐다.
 *
 * 그 배제는 **타입이 강제한다**: `snapshotStudyWorkspace()` 의 반환형이
 * `StudyWorkspaceSnapshot`(= `Persisted` 에서 `groupViews` 를 뺀 것)이다. 구조적
 * 부분집합이라 `Persisted` 를 그대로 넘겨도 컴파일은 통과하므로(변수 대입에는 excess
 * property check 가 안 걸린다), 그 좁은 타입을 경유하는 것이 유일한 방어다.
 *
 * 적용해도 그룹이 보고 있는 저장뷰는 그대로다(`applySnapshot` 이 payload 의
 * `groupViews` 를 읽지 않는다). 창 배치·지표·paneOrder 만 교체된다. `chart.timeframe`
 * 필드가 payload 에 남는 이유는 창 설정 타입을 `/live` 와 공유하기 때문이다
 * (복제 금지, #906).
 */

export function captureStudyPresetPayload(): StudyLayoutPresetPayload {
  return snapshotStudyWorkspace();
}

export function applyStudyPresetPayload(
  payload: StudyLayoutPresetPayload,
  presetId: string | null,
): void {
  // applySnapshot 이 정규화·persist·chartRuntime 비우기를 모두 한다(fresh-view).
  useStudyWorkspaceStore.getState().applySnapshot(payload);
  useStudyActivePresetStore.getState().setActivePresetId(presetId);
}

/** "기본 배치로 초기화" — 빈 스냅샷을 넘기면 `normalizeSnapshot` 이 유효 창 0개를 보고
 *  `buildStudyWorkspaceSeed` 로 폴백한다(공장값을 여기 나열할 필요가 없다). */
export function defaultStudyPresetPayload(): StudyLayoutPresetPayload {
  return { windows: [], zOrder: [] };
}

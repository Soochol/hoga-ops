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
 * 프리셋은 **창 배치만** 담는다(`/live` 와 달리 종목 없음). 적용해도 열린 탭·저장뷰는
 * 그대로이고, 창 배치·지표·paneOrder 만 교체된다. 한 가지 예외: payload 에 실린
 * `chart.timeframe` 은 적용 직후 활성 탭의 봉으로 덮인다 — `/study` 는 탭이 봉의
 * SSOT 라 StudyPage 가 창 봉을 탭에 맞춘다. 필드를 빼지 않는 이유는 창 설정 타입을
 * `/live` 와 공유하기 때문이다(복제 금지, #906).
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

import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';

/**
 * `/study` 의 활성 프리셋 id — "이 탭이 마지막에 적용/저장한 프리셋".
 *
 * **전용 스토어 + 탭 스코프**인 이유는 `/live` 에서 겪은 실패를 되풀이하지 않기 위해서다.
 * 거기선 이 값을 `live.layout.v1` 공유 스냅샷에 얹었는데, 그 스토어의 persist 가 필드가
 * 아니라 스냅샷 전체를 쓰는 탓에 **다른 탭의 무관한 조작**(상세 패널 접기 등)이 이 값을
 * 되돌렸다. 그 뒤 "현재 창 배치 저장"을 누르면 엉뚱한 프리셋을 덮어쓰는데, 그
 * 프리셋 자체는 변경된 적이 없어 409 낙관적 동시성으로도 잡히지 않는다(#924 §2).
 *
 * 그래서 여긴 처음부터 (1) 다른 상태와 한 블롭에 담지 않고 (2) sessionStorage(탭 스코프)에
 * 둔다. 워크스페이스 자체가 탭마다 독립이므로(#928) 활성 프리셋도 탭의 것이 맞다.
 */
export const STUDY_ACTIVE_PRESET_STORAGE_KEY = 'study.activePreset.v1';

type Store = {
  activePresetId: string | null;
  setActivePresetId: (id: string | null) => void;
};

function readStorage(): string | null {
  const parsed = readJsonObject(STUDY_ACTIVE_PRESET_STORAGE_KEY, 'tab');
  return typeof parsed.activePresetId === 'string' ? parsed.activePresetId : null;
}

export const useStudyActivePresetStore = create<Store>((set) => ({
  activePresetId: readStorage(),
  setActivePresetId: (id) => {
    persistJson(STUDY_ACTIVE_PRESET_STORAGE_KEY, { activePresetId: id }, 'tab');
    set({ activePresetId: id });
  },
}));

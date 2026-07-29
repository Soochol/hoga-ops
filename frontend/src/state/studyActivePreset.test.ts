import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 스토어가 모듈 로드 시 하이드레이션하므로 저장소를 세운 뒤 신선하게 다시 불러온다. */
async function importFresh() {
  vi.resetModules();
  return import('./studyActivePreset');
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/** `/live` 는 활성 프리셋 id 를 공유 스냅샷에 얹었다가 탭 간 되돌림 경로를 만들었다
 *  (#924 §2). `/study` 는 처음부터 전용 키 + 탭 스코프로 둔다. */
describe('studyActivePreset — 탭 스코프 전용 스토어', () => {
  it('설정하면 sessionStorage 에 기록한다(localStorage 아님)', async () => {
    const { useStudyActivePresetStore, STUDY_ACTIVE_PRESET_STORAGE_KEY } = await importFresh();

    useStudyActivePresetStore.getState().setActivePresetId('p1');

    expect(JSON.parse(sessionStorage.getItem(STUDY_ACTIVE_PRESET_STORAGE_KEY) ?? '{}'))
      .toEqual({ activePresetId: 'p1' });
    // 공유 저장소는 건드리지 않는다 — 다른 탭의 활성 프리셋을 밀지 않는다.
    expect(localStorage.getItem(STUDY_ACTIVE_PRESET_STORAGE_KEY)).toBeNull();
  });

  it('탭 저장소에서 하이드레이션한다', async () => {
    sessionStorage.setItem('study.activePreset.v1', JSON.stringify({ activePresetId: 'mine' }));

    const { useStudyActivePresetStore } = await importFresh();

    expect(useStudyActivePresetStore.getState().activePresetId).toBe('mine');
  });

  it('다른 탭이 localStorage 에 무엇을 두든 영향받지 않는다', async () => {
    localStorage.setItem('study.activePreset.v1', JSON.stringify({ activePresetId: 'theirs' }));

    const { useStudyActivePresetStore } = await importFresh();

    expect(useStudyActivePresetStore.getState().activePresetId).toBeNull();
  });

  it('null 로 지울 수 있다(기본 배치로 초기화)', async () => {
    const { useStudyActivePresetStore } = await importFresh();

    useStudyActivePresetStore.getState().setActivePresetId('p1');
    useStudyActivePresetStore.getState().setActivePresetId(null);

    expect(useStudyActivePresetStore.getState().activePresetId).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('study.activePreset.v1') ?? '{}'))
      .toEqual({ activePresetId: null });
  });
});

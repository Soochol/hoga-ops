import { useStudyActivePresetStore } from '../../state/studyActivePreset';
import { PresetMenu, type PresetRow } from '../../workspace/presets/PresetMenu';
import { useStudyLayoutPresets, useStudyLayoutPresetMutations } from './useStudyLayoutPresets';
import {
  applyStudyPresetPayload,
  captureStudyPresetPayload,
  defaultStudyPresetPayload,
} from './studyLayoutPresetSnapshot';
import {
  STUDY_LAYOUT_PRESET_CONFLICT,
  type StudyLayoutPresetPayload,
} from '../../api/studyLayoutPresets';
import type { ApiError } from '../../api/client';

/**
 * `/study` 레이아웃 프리셋 드롭다운. UI 는 `/live` 와 공유하고
 * (`workspace/presets/PresetMenu`) 여기선 어댑터만 준다.
 *
 * `/live` 와의 계약 차이가 문구에 드러난다: 프리셋이 담는 것은 **창 배치**뿐이라
 * 적용해도 열린 탭·종목은 그대로다. 탭을 닫으면 그 탭 배치가 사라지므로(#928 탭 격리)
 * 아끼는 배치를 남기는 수단이 바로 이 프리셋이다.
 */
export function StudyLayoutPresetMenu() {
  const { data, refetch } = useStudyLayoutPresets();
  const { create, update, remove } = useStudyLayoutPresetMutations();
  const activePresetId = useStudyActivePresetStore((s) => s.activePresetId);

  return (
    <PresetMenu<StudyLayoutPresetPayload>
      testIdPrefix="study-layout-preset"
      presets={(data?.presets ?? []) as PresetRow<StudyLayoutPresetPayload>[]}
      refetchPresets={() => void refetch()}
      activePresetId={activePresetId}
      capture={captureStudyPresetPayload}
      apply={applyStudyPresetPayload}
      defaultPayload={defaultStudyPresetPayload}
      isConflict={(e) => (e as ApiError)?.code === STUDY_LAYOUT_PRESET_CONFLICT}
      saveExisting={(preset, payload, handlers) =>
        update.mutate(
          {
            id: preset.id,
            body: {
              name: preset.name,
              payload,
              expected_updated_at_ms: preset.updated_at_ms,
            },
          },
          { onSuccess: () => handlers.onSuccess(), onError: handlers.onError },
        )
      }
      saveNew={(name, payload, handlers) =>
        create.mutate(
          { name, payload },
          {
            onSuccess: (row) => {
              useStudyActivePresetStore.getState().setActivePresetId(row.id);
              handlers.onSuccess({ id: row.id });
            },
            onError: handlers.onError,
          },
        )
      }
      removePreset={(id, handlers) =>
        remove.mutate(id, { onSuccess: () => handlers.onSuccess(), onError: handlers.onError })
      }
      labels={{
        buttonFallback: '배치',
        ariaLabel: '창 배치 프리셋',
        applyHint: '창 배치만 교체됩니다 — 열린 탭·종목은 그대로',
        applyTitle: '이 배치로 교체 — 열린 탭·종목은 유지됩니다',
        saveCurrent: '현재 창 배치 저장',
        reset: '기본 배치로 초기화',
      }}
    />
  );
}

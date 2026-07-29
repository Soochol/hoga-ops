import { useLiveLayoutStore } from '../../state/liveLayout';
import { PresetMenu, type PresetRow } from '../../workspace/presets/PresetMenu';
import { useLiveLayoutPresets, useLiveLayoutPresetMutations } from './useLiveLayoutPresets';
import {
  applyPresetPayload,
  capturePresetPayload,
  defaultPresetPayload,
} from './layoutPresetSnapshot';
import {
  LIVE_LAYOUT_PRESET_CONFLICT,
  type LiveLayoutPresetPayload,
} from '../../api/liveLayoutPresets';
import type { ApiError } from '../../api/client';

/**
 * `/live` 레이아웃 프리셋 드롭다운 (ADR-0119 PR-E, v3). LiveToolbar 전용.
 *
 * v3 프리셋 = **워크스페이스 전체 스냅샷**(창·배치·그룹→종목). 적용 시 현재 창과
 * 종목이 통째 교체된다(TradingView 레이아웃 관례, #713 §5) — 문구·안내가 이를 알린다.
 *
 * UI 는 `/study` 와 공유한다(`workspace/presets/PresetMenu`). 여기 남는 것은 어댑터 —
 * 어느 API·어느 스토어·어느 워크스페이스인지만 주입한다.
 */
export function LayoutPresetMenu() {
  const { data, refetch } = useLiveLayoutPresets();
  const { create, update, remove } = useLiveLayoutPresetMutations();
  const lastAppliedPresetId = useLiveLayoutStore((s) => s.lastAppliedPresetId);

  return (
    <PresetMenu<LiveLayoutPresetPayload>
      testIdPrefix="layout-preset"
      presets={(data?.presets ?? []) as PresetRow<LiveLayoutPresetPayload>[]}
      refetchPresets={() => void refetch()}
      activePresetId={lastAppliedPresetId}
      capture={capturePresetPayload}
      apply={applyPresetPayload}
      defaultPayload={defaultPresetPayload}
      isConflict={(e) => (e as ApiError)?.code === LIVE_LAYOUT_PRESET_CONFLICT}
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
              // 새로 만든 프리셋이 곧 활성 프리셋 — "현재 워크스페이스 저장"의 대상.
              useLiveLayoutStore.getState().setLastAppliedPresetId(row.id);
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
        buttonFallback: '레이아웃',
        ariaLabel: '레이아웃 프리셋',
        applyHint: '적용 시 현재 창·종목이 통째 교체됩니다',
        applyTitle: '이 워크스페이스로 교체 — 현재 창·종목이 대체됩니다',
        saveCurrent: '현재 워크스페이스 저장',
        reset: '기본 워크스페이스로 초기화',
      }}
    />
  );
}

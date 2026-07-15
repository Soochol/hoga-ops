import { useLivePageStore } from '../../state/livePage';
import {
  DEFAULT_CARD_WEIGHTS,
  DEFAULT_RIGHT_PANEL_WIDTH_PX,
  LIVE_CARD_KEYS,
  type LiveCardKey,
  type LiveLayoutPresetInput,
  useLiveLayoutStore,
} from '../../state/liveLayout';
import { normalizeKeyOrder } from '../../state/keyOrder';
import { normalizePaneOrder } from '../../chart/paneOrder';
import { mergeLiveIndicatorPrefs } from '../../state/liveIndicatorsPersistence';
import { normalizePanePrefsByTimeframe } from '../indicators/indicatorPaneProfiles';
import type { LiveLayoutPresetPayload } from '../../api/liveLayoutPresets';
import {
  PRESET_INDICATOR_FLAG_KEYS,
  type PresetIndicatorFlags,
} from './presetFlags';

/**
 * 레이아웃 프리셋의 캡처·적용 (ADR-0114 §4). 화면 구성(pane 순서·지표 토글·우측 패널
 * 배치)만 담고 종목·타임프레임·뷰포트는 담지 않는다.
 */

const isLiveCardKey = (v: string): v is LiveCardKey =>
  (LIVE_CARD_KEYS as readonly string[]).includes(v);

function boolMap(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function numberMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** 현재 /live 화면 구성을 프리셋 payload 로 캡처한다. */
export function capturePresetPayload(): LiveLayoutPresetPayload {
  const page = useLivePageStore.getState();
  const layout = useLiveLayoutStore.getState();

  const flags: Record<string, boolean> = {};
  for (const key of PRESET_INDICATOR_FLAG_KEYS) {
    flags[key] = Boolean((page as unknown as Record<string, unknown>)[key]);
  }

  return {
    pane_order: [...page.paneOrder],
    pane_prefs_by_timeframe: JSON.parse(JSON.stringify(page.panePrefsByTimeframe)),
    indicator_flags: flags,
    right_panel_width_px: layout.rightPanelWidthPx,
    right_card_order: [...layout.rightCardOrder],
    right_card_hidden: { ...layout.rightCardHidden },
    right_card_collapsed: { ...layout.rightCardCollapsed },
    right_card_weights: { ...layout.rightCardWeights },
  };
}

/**
 * 프리셋 payload 를 현재 화면에 적용한다. 모든 필드를 클라이언트에서 canonical
 * 재정규화한 뒤, 스토어별 벌크 액션으로 각각 단일 set + 단일 persist 를 수행한다.
 * flat 레거시 pane 플래그와 panePrefsByTimeframe 를 **둘 다** 덮어써 결정론 확보.
 */
export function applyPresetPayload(payload: LiveLayoutPresetPayload, presetId: string | null): void {
  const flags: PresetIndicatorFlags = {};
  const rawFlags = boolMap(payload.indicator_flags);
  for (const key of PRESET_INDICATOR_FLAG_KEYS) {
    if (key in rawFlags) flags[key] = rawFlags[key];
  }

  useLivePageStore.getState().applyIndicatorPreset({
    paneOrder: normalizePaneOrder(payload.pane_order),
    panePrefsByTimeframe: normalizePanePrefsByTimeframe(payload.pane_prefs_by_timeframe),
    flags,
  });

  const layoutInput: LiveLayoutPresetInput = {
    rightPanelWidthPx: payload.right_panel_width_px,
    rightCardOrder: normalizeKeyOrder(payload.right_card_order, LIVE_CARD_KEYS, isLiveCardKey),
    rightCardHidden: boolMap(payload.right_card_hidden) as Partial<Record<LiveCardKey, boolean>>,
    rightCardCollapsed: boolMap(payload.right_card_collapsed) as Partial<Record<LiveCardKey, boolean>>,
    rightCardWeights: numberMap(payload.right_card_weights) as Record<LiveCardKey, number>,
  };
  useLiveLayoutStore.getState().applyLayoutPreset(layoutInput);
  // "마지막 적용" 기록 — 이후 수동 조정에도 유지된다.
  useLiveLayoutStore.getState().setLastAppliedPresetId(presetId);
}

/** 기본 레이아웃(코드 기본값) payload — "기본으로 초기화"에 사용. */
export function defaultPresetPayload(): LiveLayoutPresetPayload {
  const prefs = mergeLiveIndicatorPrefs(undefined);
  const flags: Record<string, boolean> = {};
  for (const key of PRESET_INDICATOR_FLAG_KEYS) {
    flags[key] = Boolean((prefs as unknown as Record<string, unknown>)[key]);
  }
  return {
    pane_order: [...prefs.paneOrder],
    pane_prefs_by_timeframe: {},
    indicator_flags: flags,
    right_panel_width_px: DEFAULT_RIGHT_PANEL_WIDTH_PX,
    right_card_order: [...LIVE_CARD_KEYS],
    right_card_hidden: {},
    right_card_collapsed: {},
    right_card_weights: { ...DEFAULT_CARD_WEIGHTS },
  };
}

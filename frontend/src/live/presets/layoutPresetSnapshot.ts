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
import type { LiveLayoutPresetPayload } from '../../api/liveLayoutPresets';
import {
  PRESET_INDICATOR_FLAG_KEYS,
  normalizePresetEnableByTimeframe,
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

  // 프리셋 = 4버킷 전체의 지표 on/off 스냅샷(#698·#699 PR-D). indicatorsByTimeframe
  // 는 이미 공장값 diff sparse 이므로, 각 버킷에서 enable 15키만 슬라이스하면 된다.
  // 현재 봉 투영이 아니라 버킷 원본을 읽으므로 캡처가 timeframe-무관 = 캡처→적용 항등.
  const byTimeframeEnable = Object.fromEntries(
    Object.entries(page.indicatorsByTimeframe).flatMap(([profileKey, bucket]) => {
      const slice = Object.fromEntries(
        PRESET_INDICATOR_FLAG_KEYS.flatMap((key) => (
          typeof bucket?.[key] === 'boolean' ? [[key, bucket[key]]] : []
        )),
      );
      return Object.keys(slice).length > 0 ? [[profileKey, slice]] : [];
    }),
  );

  return {
    pane_order: [...page.paneOrder],
    by_timeframe_enable: byTimeframeEnable,
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
 * 각 봉 버킷의 enable 오버라이드를 프리셋 값으로 통째 교체해 결정론 확보(#699 §5).
 */
export function applyPresetPayload(payload: LiveLayoutPresetPayload, presetId: string | null): void {
  useLivePageStore.getState().applyIndicatorPreset({
    paneOrder: normalizePaneOrder(payload.pane_order),
    byTimeframeEnable: normalizePresetEnableByTimeframe(payload.by_timeframe_enable),
  });

  const layoutInput: LiveLayoutPresetInput = {
    rightPanelWidthPx: payload.right_panel_width_px,
    rightCardOrder: normalizeKeyOrder(payload.right_card_order, LIVE_CARD_KEYS, isLiveCardKey),
    rightCardHidden: boolMap(payload.right_card_hidden) as Partial<Record<LiveCardKey, boolean>>,
    rightCardCollapsed: boolMap(payload.right_card_collapsed) as Partial<Record<LiveCardKey, boolean>>,
    rightCardWeights: numberMap(payload.right_card_weights) as Record<LiveCardKey, number>,
    // "마지막 적용" 기록을 배치 입력에 포함 — applyLayoutPreset 이 단일 persist 로 함께
    // 쓴다(별도 setLastAppliedPresetId 호출 = 두 번째 persist 제거, 코드 리뷰).
    lastAppliedPresetId: presetId,
  };
  useLiveLayoutStore.getState().applyLayoutPreset(layoutInput);
}

/** 기본 레이아웃(코드 기본값) payload — "기본으로 초기화"에 사용.
 *  by_timeframe_enable 를 비우면 적용 시 전 봉이 공장 기본값(#697 — 거래량+MA만
 *  on)으로 리셋된다 — 별도 플래그 나열 없이 sparse 모델이 공장값을 그대로 태운다. */
export function defaultPresetPayload(): LiveLayoutPresetPayload {
  return {
    pane_order: normalizePaneOrder(undefined),
    by_timeframe_enable: {},
    right_panel_width_px: DEFAULT_RIGHT_PANEL_WIDTH_PX,
    right_card_order: [...LIVE_CARD_KEYS],
    right_card_hidden: {},
    right_card_collapsed: {},
    right_card_weights: { ...DEFAULT_CARD_WEIGHTS },
  };
}

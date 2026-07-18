import { apiAction, apiCall } from './client';
import type { LineStyle } from '../chart/drawing/types';

/**
 * 레이아웃 프리셋 API 클라이언트 (ADR-0114 §4). study-views 클론.
 * payload 는 snake_case(백엔드 pydantic 미러). 종목·타임프레임·뷰포트는 미포함.
 */
export type LiveLayoutPresetPayload = {
  pane_order: string[];
  /** 프리셋 = 4버킷(분/일/주/월) 전체의 지표 on/off 스냅샷(#698·#699 PR-D).
   *  각 버킷은 공장값과 다른 enable 키만 담는 sparse 맵. 파라미터(색·기간)는
   *  프리셋 범위 밖이라 담지 않는다. 구 payload 의 pane_prefs_by_timeframe +
   *  indicator_flags 를 이 하나로 통합. */
  by_timeframe_enable: Record<string, Record<string, boolean>>;
  right_panel_width_px: number;
  right_card_order: string[];
  right_card_hidden: Record<string, boolean>;
  right_card_collapsed: Record<string, boolean>;
  right_card_weights: Record<string, number>;
};

export type LiveLayoutPreset = {
  schema_version: 2;
  id: string;
  name: string;
  payload: LiveLayoutPresetPayload;
  created_at_ms: number;
  updated_at_ms: number;
};

export type LiveLayoutPresetListRow = LiveLayoutPreset;
export type LiveLayoutPresetsFile = { schema_version: number; presets: LiveLayoutPresetListRow[] };

export type LiveLayoutPresetWriteRequest = {
  name: string;
  payload: LiveLayoutPresetPayload;
};

// LineStyle 은 프리셋 payload 엔 직접 안 실리지만(호가 level style 은 flags 대상 아님),
// 타입 재노출로 소비자가 한 곳에서 import 하도록 유지.
export type { LineStyle };

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const listLiveLayoutPresets = () =>
  apiCall<LiveLayoutPresetsFile>('/api/live-layout-presets');
export const createLiveLayoutPreset = (body: LiveLayoutPresetWriteRequest) =>
  apiCall<LiveLayoutPresetListRow>('/api/live-layout-presets', { method: 'POST', ...json(body) });
export const updateLiveLayoutPreset = (id: string, body: LiveLayoutPresetWriteRequest) =>
  apiCall<LiveLayoutPresetListRow>(`/api/live-layout-presets/${id}`, { method: 'PUT', ...json(body) });
export const deleteLiveLayoutPreset = (id: string) =>
  apiAction(`/api/live-layout-presets/${id}`, { method: 'DELETE' });

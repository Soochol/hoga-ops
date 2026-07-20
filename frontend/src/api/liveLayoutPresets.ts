import { apiAction, apiCall } from './client';
import type { LineStyle } from '../chart/drawing/types';

/**
 * 레이아웃 프리셋 API 클라이언트 (ADR-0119 PR-E, #713 §5). study-views 클론.
 *
 * v3: payload = **워크스페이스 전체 스냅샷**(창 목록·z순서·그룹→종목). 프론트-네이티브
 * camelCase 를 그대로 담는 얕은 컨테이너 — 백엔드는 저장/반환만, 검증·정규화는 프론트가
 * apply 시점에 한다(`applyWorkspaceSnapshot`→`readWindow`). windows 원소·groupSymbols
 * 값은 자유 구조(창 kind별 chart 설정 등). 뷰포트·비영속 런타임은 미포함(§6).
 */
export type LiveLayoutPresetPayload = {
  windows: unknown[];
  zOrder: string[];
  groupSymbols: Record<string, unknown>;
};

export type LiveLayoutPreset = {
  schema_version: 3;
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

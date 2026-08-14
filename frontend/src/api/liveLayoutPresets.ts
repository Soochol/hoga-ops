import { apiAction, apiCall } from './client';
import type { LineStyle } from '../chart/drawing/types';

/**
 * 레이아웃 프리셋 API 클라이언트 (ADR-0119 PR-E, #713 §5). study-views 클론.
 *
 * payload = **창 목록·z순서**. 프론트-네이티브 camelCase 를 그대로 담는 얕은 컨테이너 —
 * 백엔드는 저장/반환만, 검증·정규화는 프론트가 apply 시점에 한다
 * (`applyWorkspaceSnapshot`→`readWindow`). windows 원소는 자유 구조(창 kind별 chart
 * 설정 등). 뷰포트·비영속 런타임은 미포함(§6).
 */
export type LiveLayoutPresetPayload = {
  windows: unknown[];
  zOrder: string[];
  /**
   * 구 v3 의 그룹→종목. **더 이상 쓰지 않는다** — 저장은 빈 객체를 보내고 적용은
   * 읽지 않는다(프리셋은 배치만, `state/workspace.ts` 의 `WorkspaceSnapshot` 참조).
   *
   * 필드를 지우지 않는 이유는 백엔드 모델이 그대로라 응답에 **항상 있기** 때문이다
   * (`hoga/api/models.py` 의 `default_factory=dict`) — 손 미러의 정확성을 위해 자리를
   * 남긴다(ADR-0004). 옛 프리셋에는 실제 종목이 들어 있을 수 있고, 그 값은 적용
   * 시점에 버려진다.
   */
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
  /** 낙관적 동시성(PUT 전용) — 읽었던 시점의 updated_at_ms. 그 사이 다른 탭·기기가
   *  먼저 저장했으면 백엔드가 409(`LIVE_LAYOUT_PRESET_CONFLICT`)로 거절한다. 생략하면
   *  종전대로 무조건 덮어쓴다. payload 가 워크스페이스 통째 스냅샷이라 병합이 불가능해
   *  "거절 후 재조회"가 유일하게 정직한 처리다. */
  expected_updated_at_ms?: number;
};

/** 백엔드 409 detail.code — apiCall 이 구조화 detail 에서 ApiError.code 로 실어준다. */
export const LIVE_LAYOUT_PRESET_CONFLICT = 'live_layout_preset_conflict';

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

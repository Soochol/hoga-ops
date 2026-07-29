import { apiAction, apiCall } from './client';

/**
 * `/study` 레이아웃 프리셋 API 클라이언트 — `liveLayoutPresets.ts` 와 동형이되
 * payload 가 **창 배치만**이다(종목 없음).
 *
 * `/live` 는 groupSymbols(그룹→종목)를 함께 담아 적용 시 종목까지 교체하지만, `/study`
 * 의 종목·구간은 탭(저장뷰)이 SSOT 다. 프리셋이 탭을 건드리지 않는 것이 이 리소스의
 * 계약이라 payload 에 종목 자리를 두지 않는다.
 *
 * 백엔드는 저장/반환만 하고 검증·정규화는 프론트가 apply 시점에 한다
 * (`studyWorkspace.applySnapshot` → `readWindow`).
 */
export type StudyLayoutPresetPayload = {
  windows: unknown[];
  zOrder: string[];
};

export type StudyLayoutPreset = {
  schema_version: 1;
  id: string;
  name: string;
  payload: StudyLayoutPresetPayload;
  created_at_ms: number;
  updated_at_ms: number;
};

export type StudyLayoutPresetListRow = StudyLayoutPreset;
export type StudyLayoutPresetsFile = { schema_version: number; presets: StudyLayoutPresetListRow[] };

export type StudyLayoutPresetWriteRequest = {
  name: string;
  payload: StudyLayoutPresetPayload;
  /** 낙관적 동시성(PUT 전용) — `/live` 와 같은 계약. 생략하면 무조건 덮어쓴다. */
  expected_updated_at_ms?: number;
};

/** 백엔드 409 detail.code. `/live` 와 구분돼야 어느 목록을 다시 읽을지 알 수 있다. */
export const STUDY_LAYOUT_PRESET_CONFLICT = 'study_layout_preset_conflict';

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const listStudyLayoutPresets = () =>
  apiCall<StudyLayoutPresetsFile>('/api/study-layout-presets');
export const createStudyLayoutPreset = (body: StudyLayoutPresetWriteRequest) =>
  apiCall<StudyLayoutPresetListRow>('/api/study-layout-presets', { method: 'POST', ...json(body) });
export const updateStudyLayoutPreset = (id: string, body: StudyLayoutPresetWriteRequest) =>
  apiCall<StudyLayoutPresetListRow>(`/api/study-layout-presets/${id}`, { method: 'PUT', ...json(body) });
export const deleteStudyLayoutPreset = (id: string) =>
  apiAction(`/api/study-layout-presets/${id}`, { method: 'DELETE' });

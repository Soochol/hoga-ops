import { apiAction, apiCall } from './client';
import type { LiveTimeframe } from '../state/livePage';

export type StudyViewport = {
  right_edge_ms: number;
  bar_span: number;
  at_live_edge: boolean;
  right_padding_bars?: number | null;
};

export type StudyViewRange = {
  from_date: string;
  to_date: string;
  from_ms: number;
  to_ms: number;
};

export type StudyViewReference = {
  schema_version: 2;
  id: string;
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  range: StudyViewRange;
  viewport: StudyViewport;
  memo: string;
  tags: string[];
  created_at_ms: number;
  updated_at_ms: number;
};

export type StudyViewListRow = StudyViewReference;
export type StudyViewsFile = { schema_version: number; saves: StudyViewListRow[] };

export type StudyViewWriteRequest = {
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  range: StudyViewRange;
  viewport: StudyViewport;
  memo?: string;
  tags?: string[];
};

export type StudyViewMetadataUpdateRequest = {
  name?: string;
  memo?: string;
};

export type StudyViewSaveWriteRequest = StudyViewWriteRequest;

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const listStudyViews = () => apiCall<StudyViewsFile>('/api/study-views/saves');
export const createStudyView = (body: StudyViewSaveWriteRequest) =>
  apiCall<StudyViewListRow>('/api/study-views/saves', { method: 'POST', ...json(body) });
export const getStudyView = (id: string) => apiCall<StudyViewListRow>(`/api/study-views/saves/${id}`);
export const updateStudyView = (id: string, body: StudyViewSaveWriteRequest) =>
  apiCall<StudyViewListRow>(`/api/study-views/saves/${id}`, { method: 'PUT', ...json(body) });
export const updateStudyViewMetadata = (id: string, body: StudyViewMetadataUpdateRequest) =>
  apiCall<StudyViewListRow>(`/api/study-views/saves/${id}/metadata`, { method: 'PATCH', ...json(body) });
export const deleteStudyView = (id: string) =>
  apiAction(`/api/study-views/saves/${id}`, { method: 'DELETE' });

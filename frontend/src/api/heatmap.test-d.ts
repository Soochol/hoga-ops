import type { HeatmapEntry, HeatmapFolder, HeatmapResponse } from './heatmap';

const _heatmapFolder: HeatmapFolder = {
  id: 'f_a',
  name: '반도체',
  order: 0,
};
void _heatmapFolder;

const _heatmapEntry: HeatmapEntry = {
  code: '005930',
  name: '삼성전자',
  folder_id: 'f_a',
  order: 0,
};
void _heatmapEntry;

// v3 (ADR-0111): folder_id 는 실폴더 필수 — null(구 미분류)은 타입 오류다.
const _heatmapEntryNullFolder: HeatmapEntry = {
  code: '005930',
  name: '삼성전자',
  // @ts-expect-error 미분류(null) 상태는 v3 에서 제거됐다.
  folder_id: null,
  order: 0,
};
void _heatmapEntryNullFolder;

const _heatmapResponse: HeatmapResponse = {
  folders: [],
  entries: [_heatmapEntry],
};
void _heatmapResponse;

const _heatmapEntryWithCaptureMarker: HeatmapEntry = {
  code: '005930',
  name: '삼성전자',
  // @ts-expect-error Heatmap wire entries do not carry Watchlist capture markers.
  registered_at_kst_date: '20260601',
  folder_id: 'f_a',
  order: 0,
};
void _heatmapEntryWithCaptureMarker;

const _heatmapResponseWithNextRun: HeatmapResponse = {
  folders: [],
  entries: [],
  // @ts-expect-error Heatmap has no scheduler boundary field.
  next_run_at_ms: 0,
};
void _heatmapResponseWithNextRun;

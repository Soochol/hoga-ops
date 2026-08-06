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

// v3 (ADR-0112): folder_id 는 실폴더 필수 — null(구 미분류)은 타입 오류다.
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
  capture_markers: { '005930': '20260806' },
  next_run_at_ms: 0,
};
void _heatmapResponse;

// ADR-0142: 히트맵도 캡처 대상이 됐지만 마커는 **entry 가 아니라 code 키 맵**에 산다.
// entry identity 가 (folder_id, code) 라 entry 에 실으면 한 종목이 3그룹에 있을 때 값이
// 3벌로 갈라지는데, 그 마커가 가리키는 캡처는 (code,date) 하나뿐이기 때문이다.
const _heatmapEntryWithCaptureMarker: HeatmapEntry = {
  code: '005930',
  name: '삼성전자',
  // @ts-expect-error 마커는 entry 가 아니라 HeatmapResponse.capture_markers 에 실린다.
  last_success_date: '20260806',
  folder_id: 'f_a',
  order: 0,
};
void _heatmapEntryWithCaptureMarker;

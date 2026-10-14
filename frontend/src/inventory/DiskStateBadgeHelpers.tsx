import type { DiskStateValue } from '../api/types';


/** 표시 축의 키. wire 의 `DiskStateValue` 에 **확정 결손** 한 칸을 더한 것이다.
 *
 *  `disk_state` 자체를 쪼개지 않은 이유: `disk_state === 'source_partial'` 이
 *  결손 패널 노출(StockDateGroupDetail)·정렬 severity·재캡처 게이트를 좌우해서,
 *  값을 나누면 정작 확정 행에서 상세가 사라진다. 확정 여부는 표시 축이지 상태
 *  축이 아니므로 severity·정렬·집계는 아래에서 `DiskStateValue` 로 남는다. */
export type DiskStateDisplay = DiskStateValue | 'source_partial_confirmed';


/** wire 행 → 표시 키. 서버가 준 판정(`upstream_gap_confirmed`)만 읽는다 —
 *  클라이언트에서 `identical_capture_count >= 2` 로 재조립하면 안 된다. 그건
 *  확정 경로 셋 중 하나(ADR-0093)일 뿐이고, 세션 경계(ADR-0126)·보유 창 만료
 *  (ADR-0131)는 여기서 알 수 없다(후자는 오늘 날짜가 있어야 한다). */
export function displayStateFor(
  state: DiskStateValue, upstreamGapConfirmed?: boolean,
): DiskStateDisplay {
  return state === 'source_partial' && upstreamGapConfirmed === true
    ? 'source_partial_confirmed'
    : state;
}


/** 짧은 한국어 라벨 — 툴팁 나열("부분 · 미완결 · 손상")용. */
export const STATE_SHORT_LABEL: Record<DiskStateValue, string> = {
  complete: '완결',
  source_partial: '부분',
  client_incomplete: '미완결',
  invalid: '손상',
};


/**
 * Disk State Severity — 도메인 SSOT (CONTEXT.md 참조).
 * 높은 숫자 = 더 심각한 상태. aggregateDiskState와 inventory 컬럼 정렬이 공유.
 */
export const STATE_SEVERITY: Record<DiskStateValue, number> = {
  complete: 0,
  source_partial: 1,
  client_incomplete: 2,
  invalid: 3,
};


/** The non-complete DiskStates a user can re-capture. Order is presentational
 *  (used to build tooltips like "source partial · client incomplete · invalid").
 *  Single source of truth: both `isRecapturable` and `RecaptureActionBar`'s
 *  tooltip flow from this list. Adding a new non-complete DiskStateValue means
 *  adding it here once. */
export const RECAPTURABLE_DISK_STATES: readonly DiskStateValue[] = [
  'source_partial',
  'client_incomplete',
  'invalid',
];


/** A captured Stock-Date is recapturable when its DiskState appears in
 *  RECAPTURABLE_DISK_STATES (everything except complete). Backend policy
 *  (eligibility.py) skips COMPLETE even on explicit recapture. */
export function isRecapturable(state: DiskStateValue): boolean {
  return (RECAPTURABLE_DISK_STATES as readonly DiskStateValue[]).includes(state);
}


/** 그룹 전체의 집계 상태 — 가장 심한 단계 반환. STATE_SEVERITY를 SSOT로 참조. */
export function aggregateDiskState(states: DiskStateValue[]): DiskStateValue {
  let worst: DiskStateValue = 'complete';
  for (const s of states) {
    if (STATE_SEVERITY[s] > STATE_SEVERITY[worst]) worst = s;
  }
  return worst;
}

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

/** 같은 어휘로 CalendarCell의 마커와 일치시킨다 (DESIGN.md status semantic 토큰).
 *  어휘 계약: 글리프·라벨(완결 ✓/부분 ⚠/부분 확정 ⊘/미완결 ✕/손상 !)은 캡처
 *  달력의 calendarStatus.ts CALENDAR_STATUS 와 동일해야 한다 — 같은 종목·날짜가
 *  두 페이지에서 다른 이름·글리프로 보이면 다른 상태로 오독된다.
 *  라벨은 표시용 한국어 — 원 상태값(DiskStateValue)은 wire·정렬 계약으로 남는다. */
const PRESENTATION: Record<DiskStateDisplay, { marker: string; color: string; label: string }> = {
  complete:          { marker: '✓', color: 'var(--success)', label: '완결' },
  source_partial:    { marker: '⚠', color: 'var(--warn)',    label: '부분 — 업스트림 결손 가능 (재캡처로 복구 안 될 수 있음)' },
  // amber ⚠ 는 "조치하라" 를 뜻하는데 확정 결손엔 할 수 있는 조치가 없다.
  // 색만 바꾸면 한 눈에 안 갈리므로 글리프 자체를 달리한다(달력과 동일).
  source_partial_confirmed: {
    marker: '⊘', color: 'var(--fg-dimmer)',
    label: '부분 확정 — 업스트림 결손 확인 (재캡처해도 동일)',
  },
  client_incomplete: { marker: '✕', color: 'var(--error)',   label: '미완결 — 다음 캡처에서 이어받음' },
  invalid:           { marker: '!', color: 'var(--error)',   label: '손상 — 데이터 무결성 위반' },
};

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

export function DiskStateBadge(
  { state, upstreamGapConfirmed }: { state: DiskStateValue; upstreamGapConfirmed?: boolean },
) {
  const p = PRESENTATION[displayStateFor(state, upstreamGapConfirmed)];
  return (
    <span
      title={p.label}
      aria-label={p.label}
      className="font-data text-sm leading-none"
      style={{ color: p.color }}
    >
      {p.marker}
    </span>
  );
}

/** 그룹 전체의 집계 상태 — 가장 심한 단계 반환. STATE_SEVERITY를 SSOT로 참조. */
export function aggregateDiskState(states: DiskStateValue[]): DiskStateValue {
  let worst: DiskStateValue = 'complete';
  for (const s of states) {
    if (STATE_SEVERITY[s] > STATE_SEVERITY[worst]) worst = s;
  }
  return worst;
}

/** 좌측 리스트용 작은 점. complete면 렌더 안 함(노이즈 방지). */
export function DiskStateDot({ state }: { state: DiskStateValue }) {
  if (state === 'complete') return null;
  const p = PRESENTATION[state];
  return (
    <span
      title={`이 종목의 캡처 중 ${p.label}이 있음`}
      aria-label={p.label}
      className="inline-block w-1.5 h-1.5 rounded-full"
      style={{ backgroundColor: p.color }}
    />
  );
}

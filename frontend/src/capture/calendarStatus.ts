// Single source of truth for the visual presentation of a CalendarStatus.
// Mirrors the PhaseDescriptor pattern in phase.ts. Adding a new
// CalendarStatus requires exactly one row here — TypeScript's
// Record<CalendarStatus, _> exhaustiveness flags any miss.
import type { CalendarStatus } from '../api/types';

// 어휘 계약: 디스크 상태 4종(complete/source_partial/client_incomplete/invalid)의
// 글리프·색·한국어 라벨은 보관함의 DiskStateBadge.PRESENTATION 과 **동일해야 한다**
// (완결 ✓ / 부분 ⚠ / 미완결 ✕ / 손상 !). 같은 종목·날짜가 두 페이지에서 다른
// 글리프로 보이면 사용자는 다른 상태로 오독한다. phase → CalendarStatus 매핑은
// phase.ts 의 phaseToCalendarStatus 가 소유한다.
export interface CalendarStatusDescriptor {
  /** Glyph rendered in the corner of the cell; null = no glyph. */
  marker: '✓' | '⚠' | '✕' | '!' | '◆' | '◇' | '🔒' | '–' | '⊘' | null;
  /** Per-status badge color for the marker. Optional — today_locked relies
   *  on the 🔒 glyph itself and intentionally has no separate color. */
  badgeColor?: string;
  /** Cell text color (the day-of-month digit). Always a CSS var. */
  baseColorVar: string;
  /** Hover/click disabled. Replaces the historical DISABLED_STATUSES set. */
  disabled: boolean;
  /** Suffix appended after "${date} · " in tooltip text.
   *  null → tooltip is just "${date}" (no separator, matches the historical
   *  default for the `none` status). */
  tooltipSuffix: string | null;
  /** Legend chunk like "✓ complete". null → not surfaced in the Legend at all
   *  (weekend/holiday/future/none). */
  legendLabel: string | null;
}

export const CALENDAR_STATUS: Record<CalendarStatus, CalendarStatusDescriptor> = {
  complete: {
    marker: '✓',
    badgeColor: 'var(--success)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: '완결 — 수집 완료',
    legendLabel: '✓ 완결',
  },
  source_partial: {
    marker: '⚠',
    badgeColor: 'var(--warn)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: '부분 — 업스트림 결손 가능 (재캡처로 복구 안 될 수 있음)',
    legendLabel: '⚠ 부분',
  },
  source_partial_confirmed: {
    // 같은 "부분" 이지만 **끝난** 부분이다. ⚠ 를 재사용하지 않는 이유: amber ⚠ 는
    // "조치하라" 를 말하는데 여기서 할 수 있는 조치가 없다. 최근 실측(2026-08-03,
    // hogaplay 247종목 중 246종목이 09:02~09:05 동일 결손)처럼 결손이 전 종목·연일로
    // 번지면 ⚠ 가 달력을 뒤덮어 신호 가치를 잃는다 — 그 대량 구간을 갈라 내는 것이
    // 이 상태의 목적이다.
    //
    // 글리프는 ⊘("더 채울 수 없음"), 색은 --fg-dimmer 로 가라앉힌다. 낮 숫자
    // (baseColorVar)는 --fg 를 유지한다 — no_upstream_data 처럼 흐리게 하면 "그날
    // 데이터가 없다" 로 오독되는데, 실제로는 하루 대부분이 정상 수집돼 있다.
    // (--fg-dimmer 는 DESIGN.md 2026-08-04 규칙상 장식 글리프에 허용된 자리다.)
    //
    // 셀은 클릭 가능하게 둔다: 캡처 폼의 강제 재시도(force_retry)가 이 판정을
    // 우회해 재검증하는 유일한 경로다.
    //
    // 위 어휘 계약의 예외다 — 보관함 DiskStateBadge 에 대응 행이 없다. 이건
    // 디스크 상태 5종이 아니라 `source_partial` 의 **달력 전용 정제**이고,
    // 판정에 필요한 `upstream_gap_confirmed` 가 보관함 wire(disk_state)에는
    // 실리지 않는다. 보관함은 같은 Stock-Date 를 '⚠ 부분' 으로 두되 행을 펼치면
    // "업스트림 결손 N구간" 패널로 같은 사실을 더 자세히 말한다.
    marker: '⊘',
    badgeColor: 'var(--fg-dimmer)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: '부분 확정 — 업스트림 결손 확인 (재캡처해도 동일)',
    legendLabel: '⊘ 부분 확정',
  },
  client_incomplete: {
    // 종전 범례가 이 상태를 '손상'이라 불렀다 — 보관함(DiskStateBadge)은 같은
    // 상태를 '미완결'로 부르고 있어 같은 날짜가 두 페이지에서 다른 이름이었다.
    marker: '✕',
    badgeColor: 'var(--error)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: '미완결 — 다음 캡처에서 이어받음',
    legendLabel: '✕ 미완결',
  },
  invalid: {
    // ADR-0020 — DiskState.INVALID reaches the wire when a Stock-Date has an
    // error-severity invariant violation. 글리프는 보관함과 동일한 '!' —
    // 종전엔 '✕'(미완결과 동일)에 범례도 없어 구분 불가였다.
    marker: '!',
    badgeColor: 'var(--error)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: '손상 — 데이터 무결성 위반 (재캡처 필요)',
    legendLabel: '! 손상',
  },
  no_upstream_data: {
    // ADR-0021 — hogaplay info.php returned 200 + empty body. The cell stays
    // clickable so the next capture can re-attempt; the dim baseColor + en-dash
    // marker signal absence (distinct from '✕' broken which means "data
    // exists but collection was interrupted").
    marker: '–',
    badgeColor: 'var(--fg-dimmer)',
    baseColorVar: 'var(--fg-dim)',
    disabled: false,
    tooltipSuffix: '업스트림 데이터 없음 (캡처 시 재시도)',
    legendLabel: '– 업스트림 없음',
  },
  complete_live: {
    // hogaplay 산출물이 전혀 없고 실시간 승격본만 있는 날(calendar.py
    // _cell_status_for). 글리프를 ◆(다이아)로 분화 — 종전엔 hogaplay 완결과 같은
    // ✓에 색만 달라 색각 이상·저대비에서 구분 불가였다. 색은 캡처 배지 정체성 토큰.
    // Cell stays clickable — this date is still a hogaplay target.
    //
    // 라벨에 **벤더명을 박지 않는다**. 이 자리는 한 번 갈렸다: 도입 당시 승격
    // 소스는 `kis_live`(KIS WS) 하나뿐이라 "KIS 실시간"이라 불렀는데, ADR-0136이
    // 실시간을 전부 키움으로 옮기고 `kis_live`가 삭제된 뒤에도(2026-08-06
    // b2a8f551) 문구만 남아 **키움 데이터를 KIS라 부르고 있었다**. 상태의 뜻은
    // "hogaplay가 아닌 실시간 승격본"이지 특정 벤더가 아니다.
    marker: '◆',
    badgeColor: 'var(--source-capture-border)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: '실시간 승격 데이터 (hogaplay 미수집)',
    legendLabel: '◆ 실시간 승격',
  },
  partial_live: {
    // 같은 승격본에 세션 결손이 있는 경우. ◇(빈 다이아) — 승격 계열은 다이아
    // 모양 가족으로 묶는다(◆ 완결 / ◇ 부분). 벤더 중립 근거는 complete_live 참조.
    marker: '◇',
    badgeColor: 'var(--source-capture-border)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: '실시간 승격 데이터, 부분 (hogaplay 미수집)',
    legendLabel: '◇ 실시간 승격 부분',
  },
  today_locked: {
    marker: '🔒',
    baseColorVar: 'var(--fg-dim)',
    disabled: true,
    tooltipSuffix: '당일 16:30 이전 (잠김)',
    legendLabel: '🔒 당일 16:30 이전',
  },
  weekend: {
    marker: null,
    baseColorVar: 'var(--fg-dimmer)',
    disabled: true,
    tooltipSuffix: '주말',
    legendLabel: null,
  },
  holiday: {
    marker: null,
    baseColorVar: 'var(--fg-dimmer)',
    disabled: true,
    tooltipSuffix: 'KRX 휴장일',
    legendLabel: null,
  },
  future: {
    marker: null,
    baseColorVar: 'var(--fg-dimmer)',
    disabled: true,
    tooltipSuffix: '미래 날짜',
    legendLabel: null,
  },
  none: {
    marker: null,
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: null,
    legendLabel: null,
  },
};

/** Order in which Legend chunks appear in the Capture form footer.
 *  Statuses with `legendLabel: null` are skipped. */
export const LEGEND_ORDER: readonly CalendarStatus[] = [
  'complete',
  'source_partial',
  'source_partial_confirmed',   // ⚠ 바로 뒤 — 같은 축의 정제라 붙여 읽혀야 한다
  'client_incomplete',
  'invalid',
  'no_upstream_data',
  'complete_live',
  'partial_live',
  'today_locked',
];

/** Derived helpers — exposed so existing call sites can swap inline branches
 *  for a single lookup without changing observable behavior. */

export function markerFor(status: CalendarStatus): CalendarStatusDescriptor['marker'] {
  return CALENDAR_STATUS[status].marker;
}

export function badgeColorFor(status: CalendarStatus): string | undefined {
  return CALENDAR_STATUS[status].badgeColor;
}

export function baseColorVarFor(status: CalendarStatus): string {
  return CALENDAR_STATUS[status].baseColorVar;
}

export function isDisabled(status: CalendarStatus): boolean {
  return CALENDAR_STATUS[status].disabled;
}

export function tooltipFor(status: CalendarStatus, date: string): string {
  const suffix = CALENDAR_STATUS[status].tooltipSuffix;
  return suffix === null ? date : `${date} · ${suffix}`;
}

export function legendText(): string {
  const parts = LEGEND_ORDER
    .map((s) => CALENDAR_STATUS[s].legendLabel)
    .filter((label): label is string => label !== null);
  return `범례: ${parts.join(' · ')}`;
}

import type { CalendarStatus, CapturePhase, SkipReason } from '../api/types';

/** Display-time descriptor for a CapturePhase. The single source of truth for
 *  phase presentation in the frontend — adding a new phase means adding one row
 *  to PHASE; TypeScript's Record<CapturePhase, _> exhaustiveness flags any miss.
 */
export interface PhaseDescriptor {
  icon: string;          // ○ ● ✓ ✕ ⚠
  /** 표시용 한국어 라벨. 원값(CapturePhase)은 wire·테스트 계약이므로 여기서만 번역한다. */
  label: string;
  chipColor: string;     // CSS color for the phase chip background
  group: 'active' | 'queued' | 'terminal';
  terminal: boolean;
}

// 칩 틴트는 전부 토큰 — rgba 하드코딩 시절(~2026-08-04)엔 4개 테마 중 이 칩만
// 테마를 안 따라갔다. 중립 틴트가 없어서 --tint-neutral 을 신설했다(tokens.css).
const TEAL_TINT = 'var(--tint-selection)';
const UP_TINT = 'var(--tint-success)';
const DOWN_TINT = 'var(--tint-error)';
const NEUTRAL_TINT = 'var(--tint-neutral)';

export const PHASE: Record<CapturePhase, PhaseDescriptor> = {
  queued:    { icon: '○', label: '대기',     chipColor: NEUTRAL_TINT, group: 'queued',   terminal: false },
  deciding:  { icon: '●', label: '준비 중',  chipColor: TEAL_TINT,    group: 'active',   terminal: false },
  capturing: { icon: '●', label: '수집 중',  chipColor: TEAL_TINT,    group: 'active',   terminal: false },
  parsing:   { icon: '●', label: '파싱 중',  chipColor: TEAL_TINT,    group: 'active',   terminal: false },
  done:      { icon: '✓', label: '완료',     chipColor: UP_TINT,      group: 'terminal', terminal: true  },
  failed:    { icon: '✕', label: '실패',     chipColor: DOWN_TINT,    group: 'terminal', terminal: true  },
  cancelled: { icon: '✕', label: '취소됨',   chipColor: NEUTRAL_TINT, group: 'terminal', terminal: true  },
  skipped:   { icon: '⚠', label: '건너뜀',   chipColor: NEUTRAL_TINT, group: 'terminal', terminal: true  },
};

/** Fallback for wire drift — a backend phase added before the frontend's
 *  CapturePhase union is updated would otherwise hit `PHASE[unknown]` →
 *  undefined → TypeError mid-render. Renders as a `?` neutral chip so the
 *  queue stays alive while the type mismatch is noticed. terminal=true so
 *  the row gets no action button (safer than offering cancel on something
 *  we don't understand). */
const UNKNOWN_PHASE: PhaseDescriptor = {
  icon: '?',
  label: '알 수 없음',
  chipColor: NEUTRAL_TINT,
  group: 'terminal',
  terminal: true,
};

/** Look up a phase descriptor with runtime safety. Always returns a
 *  PhaseDescriptor — falls back to UNKNOWN_PHASE for any string outside
 *  the CapturePhase union (defends against wire drift mid-deploy). */
export function getPhase(phase: string): PhaseDescriptor {
  return PHASE[phase as CapturePhase] ?? UNKNOWN_PHASE;
}

/** Display order: active items first, then queued, then terminals at the bottom. */
export const GROUP_ORDER: Record<PhaseDescriptor['group'], number> = {
  active: 0,
  queued: 1,
  terminal: 2,
};

/** Map a terminal CapturePhase + skip_reason to the CalendarStatus that should
 *  appear in the picker. Returns null for non-terminal phases (no calendar
 *  update is owed until the item resolves).
 */
export function phaseToCalendarStatus(
  phase: CapturePhase,
  skipReason: SkipReason | null,
): CalendarStatus | null {
  if (phase === 'done') return 'complete';
  if (phase === 'skipped') {
    if (skipReason === 'source_partial') return 'source_partial';
    // 워커가 `upstream_gap` 으로 건너뛴 순간이 곧 "확정" 이다 — 셀을 ⚠ 로 두면
    // 사용자가 방금 무시당한 재캡처를 다시 누른다. (같은 skip_reason 을 쓰는
    // INVALID close_ms=0 스텁(ADR-0130)은 이 매핑이 과잉 주장이지만, 다음 GET 의
    // as_of_ms 가 패치 시각을 넘기면 `invalid` 로 정정된다 — 지금 이 자리가
    // `source_partial` 로 똑같이 틀리는 것과 수명이 같다.)
    if (skipReason === 'upstream_gap') return 'source_partial_confirmed';
    if (skipReason === 'no_upstream_data') return 'no_upstream_data';   // ADR-0021
    return 'complete';
  }
  if (phase === 'failed' || phase === 'cancelled') return 'client_incomplete';
  return null;
}

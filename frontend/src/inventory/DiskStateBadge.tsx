import type { DiskStateValue } from '../api/types';

/** 같은 어휘로 CalendarCell의 마커와 일치시킨다 (DESIGN.md status semantic 토큰). */
const PRESENTATION: Record<DiskStateValue, { marker: string; color: string; label: string }> = {
  complete:          { marker: '✓', color: 'var(--success)', label: 'complete' },
  source_partial:    { marker: '⚠', color: 'var(--warn)',    label: 'source partial — data gaps' },
  client_incomplete: { marker: '✕', color: 'var(--error)',   label: 'client incomplete — resume on capture' },
  invalid:           { marker: '!', color: 'var(--error)',   label: 'invalid — domain invariant violated' },
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

export function DiskStateBadge({ state }: { state: DiskStateValue }) {
  const p = PRESENTATION[state];
  return (
    <span
      title={p.label}
      aria-label={p.label}
      className="font-mono text-sm leading-none"
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

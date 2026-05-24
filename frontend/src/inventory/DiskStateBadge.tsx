import type { DiskStateValue } from '../api/types';

/** 같은 어휘로 CalendarCell의 마커와 일치시킨다 (DESIGN.md status semantic 토큰). */
const PRESENTATION: Record<DiskStateValue, { marker: string; color: string; label: string }> = {
  complete:          { marker: '✓', color: 'var(--success)', label: 'complete' },
  source_partial:    { marker: '⚠', color: 'var(--warn)',    label: 'source partial — data gaps' },
  client_incomplete: { marker: '✕', color: 'var(--error)',   label: 'client incomplete — resume on capture' },
  invalid:           { marker: '!', color: 'var(--error)',   label: 'invalid — domain invariant violated' },
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

/** 그룹 전체의 집계 상태 — 하나라도 비-complete가 있으면 그 중 가장 심한 단계를 반환. */
export function aggregateDiskState(states: DiskStateValue[]): DiskStateValue {
  if (states.some((s) => s === 'invalid')) return 'invalid';
  if (states.some((s) => s === 'client_incomplete')) return 'client_incomplete';
  if (states.some((s) => s === 'source_partial')) return 'source_partial';
  return 'complete';
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

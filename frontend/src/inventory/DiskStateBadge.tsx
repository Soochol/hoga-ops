import type { DiskStateValue, StockDateVenue } from '../api/types';
import { type DiskStateDisplay, displayStateFor } from './DiskStateBadgeHelpers';


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


export function DiskStateBadge(
  { state, upstreamGapConfirmed }: { state: DiskStateValue; upstreamGapConfirmed?: boolean },
) {
  const p = PRESENTATION[displayStateFor(state, upstreamGapConfirmed)];
  return (
    <span
      data-tooltip={p.label}
      aria-label={p.label}
      className="font-data text-sm leading-none"
      style={{ color: p.color }}
    >
      {p.marker}
    </span>
  );
}


/**
 * 날짜 행의 venue 별 상태 — `kiwoom_live` 가 시장별로 따로 가진 디스크 상태다
 * (ADR-0140 §7). 행의 주 상태(`disk_state`)는 hogaplay 것이고 여기와 **별개**다.
 *
 * 세 가지 모양이 세 가지 사실을 말한다:
 *
 * | 모양 | 뜻 |
 * |---|---|
 * | 자리 없음 | 이 시장에 **상장되지 않았다** — 정상적으로 없다 |
 * | 자리 + `·` | 기대됐으나 **아직 없다** |
 * | 자리 + 글리프 | 그 venue 의 상태(완결/부분/…) |
 *
 * 첫 줄이 요점이다. 미상장 종목의 NXT 를 빈 배지로 그리면 결손처럼 읽히므로,
 * 자리 자체를 안 만들어 **'정상적으로 없음'을 모양으로** 말한다. 그래서 자리 목록은
 * 백엔드의 `expected_venues`(캡처 시점 스냅샷)가 정하고 프론트가 추론하지 않는다.
 *
 * `venues` 가 비면 아무것도 안 그린다 — venue 축이 없는 행(hogaplay 전용 캡처,
 * 마이그레이션 전 평면 레이아웃)은 화면이 그대로다.
 */
export function VenueStateCell({ venues }: { venues?: StockDateVenue[] }) {
  if (!venues || venues.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="venue-state-cell">
      {venues.map((v) => (
        <span
          key={v.venue}
          data-testid={`venue-state-${v.venue}`}
          data-venue-state={v.disk_state ?? 'absent'}
          className="inline-flex items-center gap-0.5"
        >
          <span className="text-badge text-fg-dim">{v.venue}</span>
          {v.disk_state === null || v.disk_state === undefined ? (
            <span
              data-tooltip={`${v.venue} — 기대됐으나 아직 없음`}
              aria-label={`${v.venue} 없음`}
              className="font-data text-sm leading-none"
              style={{ color: 'var(--fg-dimmer)' }}
            >
              ·
            </span>
          ) : (
            <DiskStateBadge state={v.disk_state} />
          )}
        </span>
      ))}
    </span>
  );
}


/** 좌측 리스트용 작은 점. complete면 렌더 안 함(노이즈 방지). */
export function DiskStateDot({ state }: { state: DiskStateValue }) {
  if (state === 'complete') return null;
  const p = PRESENTATION[state];
  return (
    <span
      data-tooltip={`이 종목의 캡처 중 ${p.label}이 있음`}
      aria-label={p.label}
      className="inline-block w-1.5 h-1.5 rounded-full"
      style={{ backgroundColor: p.color }}
    />
  );
}

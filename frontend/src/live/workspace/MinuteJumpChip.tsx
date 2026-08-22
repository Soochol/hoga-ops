/**
 * 분봉 창 헤더의 **점프 칩** — 이 창이 지금 어느 날에 잡혀 있는지, 그리고 푸는 문.
 *
 * `SavedRangeChip` 과 **같은 자리·같은 모양**이다. 「차트가 특별한 구간에 잡혀 있다
 * + × 로 푼다」는 이미 학습된 패턴이라 새 개념을 만들지 않고 그 위에 얹는다. 헤더에
 * 사는 이유도 같다 — 차트 위 오버레이로 두면 `PaneLegendOverlay` 와 겹치는데, 켠
 * 지표 수만큼 줄이 늘어나므로 좌표를 피해 가는 방식으로는 구조적으로 못 막는다.
 *
 * ── 상태 셋이 각각 다른 말을 한다 ────────────────────────────────────────
 * `seeking` 은 **기다리면 온다**(백필 진행 중), `out-of-retention` 은 **영영 안
 * 온다**(벤더 보유 밖). 하나로 뭉치면 칩이 영원히 "불러오는 중" 을 표시하는데,
 * 그건 침묵보다 나쁜 종류의 거짓말이다. `landed` 는 도착했다는 사실만 남긴다 —
 * 그 상태에서 사용자는 자유롭게 팬할 수 있고 칩은 돌아갈 문으로만 남는다.
 */
import { jumpDateLabel } from '../../chart/timeframeJump';
import { todayKstYyyymmdd } from '../liveDateTime';
import type { MinuteJumpState } from '../useTimeframeJump';

export function MinuteJumpChip({
  state,
  onClear,
}: {
  state: MinuteJumpState;
  onClear: () => void;
}) {
  const label = jumpDateLabel(state.date, todayKstYyyymmdd());
  const warn = state.status === 'out-of-retention';
  const tone = warn ? 'var(--warn)' : 'var(--fg-muted)';

  const text = state.status === 'seeking'
    ? `점프 ${label} · 불러오는 중`
    : warn
      ? `점프 ${label} · 보유 기간 밖`
      : `점프 ${label}`;

  // 칩은 좁고 툴팁은 안 좁다 — **무엇이** 문제인지는 칩에, **결과와 대안**은 여기에.
  // `savedRangeNotice` 의 text/detail 분담과 같은 규율이다.
  const detail = state.status === 'seeking'
    ? `${state.date} 로 이동했습니다. 그 구간의 분봉을 불러오는 중입니다.`
    : warn
      ? `${state.date} 는 분봉 보유 기간(13개월) 밖이라 채울 수 없습니다. 일봉으로 보거나 더 최근 날짜를 선택하세요.`
      : `${state.date} 로 이동했습니다. × 를 누르면 최근 시각으로 돌아갑니다.`;

  return (
    <div
      data-testid="live-minute-jump-chip"
      title={detail}
      aria-label={detail}
      className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs"
      style={{ background: 'var(--tint-selection)', color: tone }}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full${state.status === 'seeking' ? ' animate-pulse' : ''}`}
        style={{ background: tone }}
      />
      <span className="truncate">{text}</span>
      <button
        type="button"
        aria-label="기간 점프 해제"
        onClick={onClear}
        className="shrink-0 rounded px-1 leading-none hover:bg-tint-hover"
        style={{ color: 'var(--fg-muted)' }}
      >
        ×
      </button>
    </div>
  );
}

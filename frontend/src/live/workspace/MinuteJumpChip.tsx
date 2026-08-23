/**
 * 분봉 창 헤더의 **점프 칩** — 이 창이 지금 어느 날에 잡혀 있는지, 그리고 푸는 문.
 *
 * `SavedRangeChip` 과 **같은 자리·같은 모양**이다. 「차트가 특별한 구간에 잡혀 있다
 * + × 로 푼다」는 이미 학습된 패턴이라 새 개념을 만들지 않고 그 위에 얹는다. 헤더에
 * 사는 이유도 같다 — 차트 위 오버레이로 두면 `PaneLegendOverlay` 와 겹치는데, 켠
 * 지표 수만큼 줄이 늘어나므로 좌표를 피해 가는 방식으로는 구조적으로 못 막는다.
 *
 * ── 상태 넷이 각각 다른 말을 한다 ────────────────────────────────────────
 * `seeking` 은 **기다리면 온다**(백필 진행 중), `out-of-retention` 은 **영영 안
 * 온다**(그 창의 하한 밖). 하나로 뭉치면 칩이 영원히 "불러오는 중" 을 표시하는데,
 * 그건 침묵보다 나쁜 종류의 거짓말이다. `landed` 는 도착했다는 사실만 남긴다 —
 * 그 상태에서 사용자는 자유롭게 팬할 수 있고 칩은 돌아갈 문으로만 남는다.
 *
 * `aborted` 는 **사용자가 기다리는 동안 그 창을 만져서** 명령이 포기된 경우다. 종전엔
 * 이것이 `landed` 에 뭉쳐 있어 칩이 "이동했다" 고 말할 수 없었다(중단된 창은 움직인
 * 적이 없으므로 거짓이 된다). 갈라 놓으니 그 상태에서 할 수 있는 일(↻ 로 다시 보내기)도
 * 화면에 둘 수 있다.
 */
import { jumpDateLabel } from '../../chart/timeframeJump';
import { todayKstYyyymmdd } from '../liveDateTime';
import type { MinuteJumpState } from '../useTimeframeJump';

export function MinuteJumpChip({
  state,
  onClear,
  onRetry,
}: {
  state: MinuteJumpState;
  onClear: () => void;
  /** ↻ — 중단된 명령을 같은 목적지로 다시 보낸다. */
  onRetry: () => void;
}) {
  const label = jumpDateLabel(state.date, todayKstYyyymmdd());
  const warn = state.status === 'out-of-retention';
  // 중단은 **오류가 아니라 사용자 행동**이라 경고 톤을 쓰지 않는다.
  const tone = warn ? 'var(--warn)' : 'var(--fg-muted)';

  const text = state.status === 'seeking'
    ? `점프 ${label} · 불러오는 중`
    : state.status === 'aborted'
      ? `점프 ${label} · 중단됨`
      : warn
        ? `점프 ${label} · 갈 수 없음`
        : `점프 ${label}`;

  // 칩은 좁고 툴팁은 안 좁다 — **무엇이** 문제인지는 칩에, **결과와 대안**은 여기에.
  // `savedRangeNotice` 의 text/detail 분담과 같은 규율이다.
  // ⚠ **`landed` 에도 "이동했습니다" 를 쓰지 않는다.** 종전엔 그 상태가 착지와 중단을
  // 함께 담아서 두 경우에 모두 참인 것(대상)밖에 적을 수 없었다. 지금은 `aborted` 가
  // 갈라져 나왔지만 문구는 그대로 둔다 — 착지한 창에서 사용자가 이미 팬해 다른 곳을
  // 보고 있을 수 있고, 그때 "이동했습니다" 는 다시 현재와 어긋난다. 칩이 항상 참인
  // 것만 말한다는 규율이 문구를 정한다.
  //
  // ⚠ **보유 기간을 상수로 적지 않는다.** 종전 문구는 「보유 기간(13개월)」이었는데
  // 이중으로 틀렸다 — 벤더 벽은 250일이고, 디스크(hogaplay) 모드에는 벽 자체가 없다.
  // 이제 그 창의 실제 하한을 상태가 나른다(`floorDate`). 값이 없으면(모드가 하한을
  // 모른다) 기간 문장을 **아예 빼고** 대안만 말한다 — 모르는 것을 지어내지 않는다.
  const detail = state.status === 'seeking'
    ? `점프 대상 ${state.date}. 그 구간의 분봉을 불러오는 중입니다.`
    : state.status === 'aborted'
      ? `점프 대상 ${state.date}. 불러오는 동안 차트를 조작해 이동이 중단됐습니다. ↻ 를 누르면 다시 보냅니다.`
      : warn
        ? [
          state.floorDate === undefined
            ? `${state.date} 의 분봉을 채울 수 없습니다.`
            : `${state.date} 는 이 창이 불러올 수 있는 가장 이른 날(${state.floorDate})보다 과거라 채울 수 없습니다.`,
          '일봉으로 보거나 더 최근 날짜를 선택하세요.',
        ].join(' ')
        : `점프 대상 ${state.date}. × 를 누르면 이 창을 점프에서 풀고 최근 시각으로 돌아갑니다.`;

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
      {state.status === 'aborted' && (
        <button
          type="button"
          aria-label="기간 점프 다시 시도"
          title="같은 목적지로 다시 보냅니다"
          onClick={onRetry}
          className="shrink-0 rounded px-1 leading-none hover:bg-tint-hover"
          style={{ color: 'var(--fg-muted)' }}
        >
          ↻
        </button>
      )}
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

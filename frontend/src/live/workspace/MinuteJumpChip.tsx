/**
 * 분봉 창 헤더의 **점프 칩** — 이 창이 지금 어느 날에 잡혀 있는지, 그리고 푸는 문.
 *
 * `SavedRangeChip` 과 **같은 자리·같은 모양**이다. 「차트가 특별한 구간에 잡혀 있다
 * + × 로 푼다」는 이미 학습된 패턴이라 새 개념을 만들지 않고 그 위에 얹는다. 헤더에
 * 사는 이유도 같다 — 차트 위 오버레이로 두면 `PaneLegendOverlay` 와 겹치는데, 켠
 * 지표 수만큼 줄이 늘어나므로 좌표를 피해 가는 방식으로는 구조적으로 못 막는다.
 *
 * ── 상태 넷이 각각 다른 말을 한다 ────────────────────────────────────────
 * `seeking` 은 **기다리면 온다**(그 구간을 받는 중), `no-data` 는 **받아 봤는데
 * 없다**, `out-of-retention` 은 **영영 안 온다**(그 창의 하한 밖). 하나로 뭉치면 칩이
 * 영원히 "불러오는 중" 을 표시하는데, 그건 침묵보다 나쁜 종류의 거짓말이다.
 * `landed` 는 도착했다는 사실만 남긴다 — 그 상태에서 사용자는 자유롭게 팬할 수 있고
 * 칩은 돌아갈 문으로만 남는다.
 *
 * ⚠ **종전의 `aborted` 와 ↻ 는 없다.** 그 상태는 "백필이 목적지까지 걸어오는 동안
 * 사용자가 그 창을 만졌다" 였는데, 이제 창의 우단을 목적지로 옮겨 한 왕복에 받으므로
 * (`useMinuteJumpTarget`) 중단될 대기 구간 자체가 사라졌다. 같은 목적지로 다시 보내는
 * 일도 발행 창에서 버튼을 한 번 더 누르면 되고, 그때 새 `seq` 가 매겨져 착지가 다시
 * 일어난다.
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
  // `no-data` 는 경고 톤을 **쓰지 않는다** — 그 날 그 종목에 봉이 없다는 것은 시장의
  // 사실이지 이 창의 고장이 아니다. 경고색은 사용자가 뭔가 다르게 할 수 있을 때만 쓴다.
  const tone = warn ? 'var(--warn)' : 'var(--fg-muted)';

  const text = state.status === 'seeking'
    ? `점프 ${label} · 불러오는 중`
    : state.status === 'no-data'
      ? `점프 ${label} · 봉 없음`
      : warn
        ? `점프 ${label} · 갈 수 없음`
        : `점프 ${label}`;

  // 칩은 좁고 툴팁은 안 좁다 — **무엇이** 문제인지는 칩에, **결과와 대안**은 여기에.
  // `savedRangeNotice` 의 text/detail 분담과 같은 규율이다.
  // ⚠ **`landed` 에도 "이동했습니다" 를 쓰지 않는다.** 착지한 창에서 사용자가 이미
  // 팬해 다른 곳을 보고 있을 수 있고, 그때 "이동했습니다" 는 현재와 어긋난다. 칩이
  // 항상 참인 것만 말한다는 규율이 문구를 정한다.
  //
  // ⚠ **보유 기간을 상수로 적지 않는다.** 종전 문구는 「보유 기간(13개월)」이었는데
  // 모드마다 틀렸다 — 벤더 하한은 두 겹이고(span 캡은 창의 우단을 따라 움직이고
  // 실보유는 달력에 붙박여 있다) 디스크 모드는 캡처가 있는 만큼이다. 이제 그 창의
  // 실제 하한을 상태가 나른다(`floorDate`). 값이 없으면(모드가 하한을 모른다) 기간
  // 문장을 **아예 빼고** 대안만 말한다 — 모르는 것을 지어내지 않는다.
  const detail = state.status === 'seeking'
    ? `점프 대상 ${state.date}. 그 구간의 분봉을 불러오는 중입니다.`
    : state.status === 'no-data'
      ? `점프 대상 ${state.date}. 그 구간을 조회했지만 봉이 없습니다(휴장일이거나 이 종목의 데이터가 없는 구간입니다). × 를 누르면 최근 시각으로 돌아갑니다.`
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

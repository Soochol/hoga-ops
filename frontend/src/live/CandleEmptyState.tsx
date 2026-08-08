import type { CandleEmptyState as State } from './candleEmptyState';
import { requestSettingsModal } from './settingsModalControls';

/**
 * 캔들이 없을 때의 빈 상태 — 판별은 `candleEmptyState.ts` 가 한다.
 *
 * **차트 영역 중앙**에 놓는다. 호가 결손 안내(`HogaMissingNotice`)가 모서리 한 줄인
 * 것과 대비되는데, 이유는 가릴 것이 있느냐다 — 호가 안내는 캔들이 그려진 위에 얹히므로
 * 작아야 하고, 이쪽은 애초에 그릴 것이 없어 중앙이 비어 있다. 빈 자리를 쓰는 편이
 * 눈에 띄고 아무것도 안 가린다.
 *
 * `pointerEvents` 를 **끄지 않는다**(호가 안내와 다른 점). 행동 버튼을 누를 수 있어야
 * 하기 때문이다. 대신 컨테이너는 `pointer-events-none` 이고 버튼만 되살려, 캔들이
 * 없는 상태에서도 차트 팬·크로스헤어가 막히지 않는다.
 */
export function CandleEmptyState({
  state,
  onRetry,
}: {
  /** `deriveCandleEmptyState` 결과. `null` 이면 렌더하지 않는다. */
  state: State | null;
  /** `action: 'retry'` 일 때 호출. 미지정이면 재시도 버튼을 숨긴다 — 누를 수 없는
   *  버튼을 보여 주는 것보다 없는 편이 정직하다. */
  onRetry?: () => void;
}) {
  if (!state) return null;
  const canAct =
    state.action === 'settings' || (state.action === 'retry' && typeof onRetry === 'function');
  return (
    <div
      data-testid="candle-empty-state"
      className="pointer-events-none absolute inset-0 z-[3] flex flex-col items-center justify-center gap-md"
    >
      {/* 벤더 원문은 `title` 로만 — 한 줄 규약을 지키면서 진단 근거는 남긴다(부분로딩
          칩과 같은 처방). 컨테이너가 `pointer-events-none` 이라 hover 를 살리려면
          원문이 있을 때만 이 span 을 `auto` 로 되살려야 한다. */}
      <span
        className={`font-data text-xs text-fg-dim${state.detail ? ' pointer-events-auto' : ''}`}
        title={state.detail}
      >
        {state.text}
      </span>
      {canAct && (
        <button
          type="button"
          data-testid="candle-empty-action"
          onClick={state.action === 'settings' ? requestSettingsModal : onRetry}
          className="pointer-events-auto rounded-lg border border-border-strong px-3 py-[7px] text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg"
        >
          {state.actionLabel}
        </button>
      )}
    </div>
  );
}

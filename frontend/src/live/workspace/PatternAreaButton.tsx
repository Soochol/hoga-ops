import { useDrawingsStore } from '../../state/drawings';
import { useRightRailStore } from '../../state/rightRail';
import { PatternIcon } from '../../ui/PatternIcon';
import { PATTERN_MAX_BARS, PATTERN_MIN_BARS } from '../../pattern/patternQuery';

/**
 * 「패턴 영역」 — 일봉에서 기간을 드래그해 봉 패턴을 찾는 진입로 (ADR-0166).
 *
 * 하는 일은 **측정자 도구를 켜고 패턴 패널을 여는 것뿐**이다. 새 드로잉 도구를 만들지
 * 않는 이유는 측정자가 이미 필요한 것을 전부 하기 때문이다:
 *
 * * 두 점 드래그로 구간을 잡고 **봉 개수를 표시**한다(몇 봉을 집었는지 그 자리에서 보인다).
 * * 그으면 **원샷으로 select 모드로 돌아가며 그 도형이 선택된다**(`measureTool` 의
 *   `revertToSelectMode`). 그래서 그은 자리가 그대로 남아 **밴드 역할**을 하고,
 *   속성 패널의 「패턴 찾기」가 곧 **실행 버튼**이 된다.
 *
 * 즉 "놓으면 밴드가 서고 버튼으로 실행" 이라는 동선이 기존 기계로 성립한다. 이 버튼은
 * 그 진입을 그리기 메뉴 밖으로 꺼내 한 번에 닿게 할 뿐이다.
 *
 * **일봉에서만 보인다** — 봉 패턴은 일봉 개념이고, 게이트는 호출부(`ChartWindow`)가
 * 가진다(속성 패널의 버튼과 같은 판정).
 */
export function PatternAreaButton({ showLabel = true }: { showLabel?: boolean }) {
  const active = useDrawingsStore((s) => s.activeTool === 'measure');
  return (
    <button
      type="button"
      aria-label="패턴 영역 — 기간을 드래그해 봉 패턴 찾기"
      title={`기간을 드래그하면 그 봉들과 닮은 패턴을 과거 전체에서 찾는다 (${PATTERN_MIN_BARS}~${PATTERN_MAX_BARS}봉)`}
      aria-pressed={active}
      onClick={() => {
        useDrawingsStore.getState().setActiveTool('measure');
        // 패널을 먼저 열어 둔다 — 그어 놓고 어디서 실행하는지 찾게 두지 않는다.
        useRightRailStore.getState().setActivePanel('pattern');
      }}
      className={
        'inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs ' +
        (active ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg')
      }
    >
      <PatternIcon filled={active} className="h-[1.125em] w-[1.125em]" />
      {showLabel && <span>패턴 영역</span>}
    </button>
  );
}

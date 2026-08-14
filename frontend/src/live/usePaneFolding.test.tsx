/**
 * `usePaneFolding` 의 **관측 부착** 회귀 테스트.
 *
 * 막는 방향: "관측 대상 DOM 이 첫 마운트 이후에 등장하거나 교체되면 ResizeObserver
 * 가 그 노드에 붙는가". `RefObject` 를 deps 로 받으면 effect 가 첫 렌더에
 * `ref.current === null` 로 조기 반환한 뒤 **다시 돌 기회가 없어** 관측자가 영영
 * 안 붙는다 — `useChartHeaderFold` 에서 실제로 터졌던 실패다(그쪽 주석 참조).
 *
 * ⚠️ 이 훅에서는 **아직 터진 적이 없다.** 유일한 호출처(`LiveChartRoot`)의 차트
 * 컨테이너가 조건부 렌더 아래가 아니기 때문이다. 그래서 이 파일은 회귀 방지가 아니라
 * **선행 가드**다 — 컨테이너를 조건부 렌더 아래로 옮기는 변경이 조용히 통과하지
 * 못하게 한다.
 *
 * 못 보는 것: 무엇을 접을지의 판정(그건 `paneFolding.test.ts` 소관), 실제 레이아웃
 * 높이(jsdom 은 `clientHeight` 가 항상 0 이라 마운트 push 가 `foldPanes` 의
 * "높이 0 = 아직 측정 전" 분기를 타고 no-op 이 된다 — 여기서는 관측 콜백을 직접
 * 발화시킨다).
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PANE_SPECS } from '../chart/paneSpecs';
import type { PaneStretchMap } from '../chart/paneOrder';
import { usePaneFolding } from './usePaneFolding';

type Observed = { el: Element; fire: (height: number) => void };

/**
 * jsdom 에는 `ResizeObserver` 가 없다. 훅은 그 부재를 가드로 처리해 **조용히 관측을
 * 건너뛰므로**, 스텁을 렌더보다 먼저 세우지 않으면 이 파일의 모든 단언이 위양성이
 * 된다. (같은 이유의 스텁이 `workspace/useChartHeaderCompact.test.tsx` 에도 있다.)
 */
function installResizeObserver(): Observed[] {
  const observed: Observed[] = [];
  class ResizeObserverStub {
    cb: ResizeObserverCallback;

    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }

    observe(el: Element): void {
      observed.push({
        el,
        fire: (height: number) => {
          this.cb([{ target: el, contentRect: { height } }] as never, this as never);
        },
      });
    }

    unobserve(): void {}

    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as never;
  return observed;
}

/** 공장 가중치 그대로 — 모듈 상수라 `useMemo` deps 가 안정적이다. */
const NO_STRETCH: PaneStretchMap = {};

/** `paneFolding.test.ts` 가 검증한 값: 6-pane 을 400px 에 넣으면 2개가 접힌다. */
const FOLDING_HEIGHT_PX = 400;
const EXPECTED_AT_400 = '2:4'; // foldedCount:남은 pane 수

function Host({ present, nodeKey = 'a' }: { present: boolean; nodeKey?: string }) {
  const [{ specs, foldedCount }, observe] = usePaneFolding(PANE_SPECS, NO_STRETCH);
  return (
    <div>
      <span data-testid="fold">{`${foldedCount}:${specs.length}`}</span>
      {present && <div key={nodeKey} data-testid="pane-host" ref={observe} />}
    </div>
  );
}

const original = globalThis.ResizeObserver;

describe('usePaneFolding — 관측 부착', () => {
  let observed: Observed[];

  beforeEach(() => {
    observed = installResizeObserver();
  });

  afterEach(() => {
    globalThis.ResizeObserver = original;
  });

  it('첫 마운트 이후에 등장한 컨테이너에도 관측자를 붙인다', () => {
    const { rerender } = render(<Host present={false} />);
    expect(observed).toHaveLength(0);
    expect(screen.getByTestId('fold')).toHaveTextContent('0:6');

    rerender(<Host present />);

    // 옛 형태(`RefObject` deps)라면 여기서 관측자가 0개다.
    expect(observed).toHaveLength(1);
    expect(observed[0].el).toBe(screen.getByTestId('pane-host'));

    act(() => observed[0].fire(FOLDING_HEIGHT_PX));
    expect(screen.getByTestId('fold')).toHaveTextContent(EXPECTED_AT_400);
  });

  it('마운트 시 이미 있는 컨테이너는 그대로 관측한다', () => {
    render(<Host present />);
    expect(observed).toHaveLength(1);

    act(() => observed[0].fire(FOLDING_HEIGHT_PX));
    expect(screen.getByTestId('fold')).toHaveTextContent(EXPECTED_AT_400);
  });

  it('컨테이너 노드가 교체되면 새 노드로 재구독한다', () => {
    const { rerender } = render(<Host present nodeKey="a" />);
    expect(observed).toHaveLength(1);

    rerender(<Host present nodeKey="b" />);

    expect(observed).toHaveLength(2);
    expect(observed[1].el).toBe(screen.getByTestId('pane-host'));
    expect(observed[1].el).not.toBe(observed[0].el);

    act(() => observed[1].fire(FOLDING_HEIGHT_PX));
    expect(screen.getByTestId('fold')).toHaveTextContent(EXPECTED_AT_400);
  });

  it('내용만 바뀐 재렌더에서는 재구독하지 않는다', () => {
    const { rerender } = render(<Host present />);
    expect(observed).toHaveLength(1);

    // callback ref 가 `useState` setter 라 참조가 안정적이라는 계약 — 이게 깨지면
    // 렌더마다 disconnect/observe 가 돌아 관측이 프레임 단위로 끊긴다.
    rerender(<Host present />);
    rerender(<Host present />);

    expect(observed).toHaveLength(1);
  });
});

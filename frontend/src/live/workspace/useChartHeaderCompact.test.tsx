/**
 * `useChartHeaderFold` 의 **관측 부착** 회귀 테스트.
 *
 * 막는 방향: "헤더 DOM 이 첫 마운트 이후에 등장하거나 교체되면 ResizeObserver 가
 * 그 노드에 붙는가". 옛 구현은 `RefObject` 를 deps 로 받아 effect 가 첫 렌더에
 * `ref.current === null` 로 조기 반환하면 **다시 돌 기회가 없었고**, 그래서 `/live`
 * 차트 창에 종목이 나중에 붙는 경로(그 전에는 `if (!instrument)` 빈 상태)에서 창을
 * 좁혀도 접힘이 통째로 죽었다. 새로고침만 살아 있던 이유는 마운트 시
 * `push(el.clientWidth)` 는 첫 렌더부터 헤더가 있는 경로에서만 도는 것이라서다.
 *
 * 못 보는 것: 임계값이 옳은지(그건 실측이 정하고 `chartHeaderCompact.test.ts` 가
 * 판정만 검증한다), 실제 레이아웃 폭(jsdom 은 `clientWidth` 가 항상 0 이라 여기서는
 * 관측 콜백을 직접 발화시킨다).
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChartHeaderFold } from './useChartHeaderCompact';
import { LIVE_HEADER_FOLD } from './chartHeaderCompact';

type Observed = { el: Element; fire: (width: number) => void };

/**
 * jsdom 에는 `ResizeObserver` 가 없다. 훅은 그 부재를 가드로 처리해 **조용히 관측을
 * 건너뛰므로**, 스텁을 렌더보다 먼저 세우지 않으면 "구독됐는지" 를 재는 이 파일의
 * 모든 단언이 위양성이 된다.
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
        fire: (width: number) => {
          this.cb([{ target: el, contentRect: { width } }] as never, this as never);
        },
      });
    }

    unobserve(): void {}

    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as never;
  return observed;
}

function Host({ present, nodeKey = 'a' }: { present: boolean; nodeKey?: string }) {
  const [fold, headerRef] = useChartHeaderFold();
  return (
    <div>
      <span data-testid="fold">{`${fold.compactActions}:${fold.compactTimeframe}`}</span>
      {present && <div key={nodeKey} data-testid="header" data-node={nodeKey} ref={headerRef} />}
    </div>
  );
}

const original = globalThis.ResizeObserver;

describe('useChartHeaderFold — 관측 부착', () => {
  let observed: Observed[];

  beforeEach(() => {
    observed = installResizeObserver();
  });

  afterEach(() => {
    globalThis.ResizeObserver = original;
  });

  it('첫 마운트 이후에 등장한 헤더에도 관측자를 붙인다', () => {
    const { rerender } = render(<Host present={false} />);
    expect(observed).toHaveLength(0);

    rerender(<Host present />);

    // 여기가 옛 구현이 죽던 지점 — deps 가 ref 객체라 effect 가 다시 돌지 않았다.
    expect(observed).toHaveLength(1);
    expect(observed[0].el).toBe(screen.getByTestId('header'));

    // 임계 아래(384/240)로 좁히면 두 단계가 함께 켜진다.
    act(() => observed[0].fire(LIVE_HEADER_FOLD.timeframeFoldWidthPx - 1));
    expect(screen.getByTestId('fold')).toHaveTextContent('true:true');
  });

  it('마운트 시 이미 있는 헤더는 그대로 관측한다', () => {
    render(<Host present />);
    expect(observed).toHaveLength(1);

    // 1단계 임계 아래·2단계 임계 위 = 액션만 접히는 구간.
    act(() => observed[0].fire(LIVE_HEADER_FOLD.labelMinWidthPx - 1));
    expect(screen.getByTestId('fold')).toHaveTextContent('true:false');
  });

  it('헤더 노드가 교체되면 새 노드로 재구독한다', () => {
    const { rerender } = render(<Host present nodeKey="a" />);
    expect(observed).toHaveLength(1);

    rerender(<Host present nodeKey="b" />);

    expect(observed).toHaveLength(2);
    expect(observed[1].el).toBe(screen.getByTestId('header'));
    expect(observed[1].el).not.toBe(observed[0].el);

    // 옛 노드의 콜백이 남아 있어도 화면은 새 노드의 폭을 따라야 한다.
    act(() => observed[1].fire(LIVE_HEADER_FOLD.timeframeFoldWidthPx - 1));
    expect(screen.getByTestId('fold')).toHaveTextContent('true:true');
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

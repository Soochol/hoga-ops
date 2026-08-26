import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  usePeakWallCountsRegistry,
  peakWallCountsKey,
  usePeakWallCountsPublisher,
} from './peakWallCountsRegistry';
import { PEAK_WALL_STEP_SLOTS } from './peakWallStepsRegistry';

describe('peakWallCountsRegistry', () => {
  beforeEach(() => {
    usePeakWallCountsRegistry.getState().clearScope(null);
    usePeakWallCountsRegistry.getState().clearScope('win-1');
  });

  // 키 목록이 계단 레지스트리와 **같은 6종**이어야 한다. 갈리면 발행은 되는데
  // 읽는 쪽이 조용히 빈 엔트리를 본다.
  it('여섯 칸이 계단 슬롯 키와 정확히 일치한다', () => {
    const fromMatrix = (['ask', 'bid'] as const).flatMap((side) =>
      (['Traded', 'Unreached', 'AllWall'] as const).map((family) => peakWallCountsKey(side, family)),
    );
    expect(new Set(fromMatrix)).toEqual(new Set(PEAK_WALL_STEP_SLOTS.map((s) => s.key)));
  });

  // 창마다 자기 개수를 갖는다 — 두 창이 다른 종목을 보고 있으면 개수도 다르다.
  it('스코프가 서로 새지 않는다', () => {
    const reg = usePeakWallCountsRegistry.getState();
    reg.register(null, 'ask-traded', { shown: 1, hiddenByFilter: 2 });
    reg.register('win-1', 'ask-traded', { shown: 9, hiddenByFilter: 0 });

    const { byScope } = usePeakWallCountsRegistry.getState();
    expect(byScope.get(null)?.get('ask-traded')).toEqual({ shown: 1, hiddenByFilter: 2 });
    expect(byScope.get('win-1')?.get('ask-traded')).toEqual({ shown: 9, hiddenByFilter: 0 });
  });

  // 미등록이 **"데이터 없음"의 유일한 신호**다 — `{shown: 0}` 으로 대체하면
  // "필터가 다 걸렀다" 와 구별되지 않는다.
  it('unregister 하면 엔트리가 사라진다 (0 으로 남지 않는다)', () => {
    const reg = usePeakWallCountsRegistry.getState();
    reg.register(null, 'ask-traded', { shown: 0, hiddenByFilter: 3 });
    usePeakWallCountsRegistry.getState().unregister(null, 'ask-traded');
    expect(usePeakWallCountsRegistry.getState().byScope.get(null)?.get('ask-traded'))
      .toBeUndefined();
  });

  // 다른 창의 Map 참조가 그대로여야 그 창이 재렌더되지 않는다(레지스트리 계약).
  it('한 스코프에 쓰면 다른 스코프의 Map 참조는 그대로다', () => {
    const reg = usePeakWallCountsRegistry.getState();
    reg.register('win-1', 'ask-traded', { shown: 1, hiddenByFilter: 0 });
    const before = usePeakWallCountsRegistry.getState().byScope.get('win-1');

    usePeakWallCountsRegistry.getState().register(null, 'bid-all', { shown: 2, hiddenByFilter: 1 });
    expect(usePeakWallCountsRegistry.getState().byScope.get('win-1')).toBe(before);
  });
});

/**
 * **deps 계약** — 이 기능의 성능 위험 전부가 여기 있다.
 *
 * `register()` 는 조건 없이 스토어를 쓴다. 발행 effect 가 팬·줌마다 돌면 개수가
 * 그대로여도 그 쓰기가 설정 패널 재렌더로 새어 나간다. 훅이 **원시값 12개**를 deps 로
 * 나열하는 이유이고, 이 테스트가 그걸 잰다.
 */
describe('usePeakWallCountsPublisher — 값이 그대로면 다시 쓰지 않는다', () => {
  const counts = (shown: number, hiddenByFilter: number) => ({ shown, hiddenByFilter });
  const input = () => ({
    // **매 호출 새 객체**를 만든다 — 팬·줌으로 훅이 재계산되는 상황의 재현이다.
    'ask-traded': counts(1, 2),
    'ask-all': counts(0, 0),
    'ask-unreached': counts(0, 0),
    'bid-traded': counts(0, 0),
    'bid-all': counts(0, 0),
    'bid-unreached': counts(0, 0),
  });

  beforeEach(() => {
    usePeakWallCountsRegistry.getState().clearScope(null);
  });

  it('같은 개수로 재렌더하면 register 가 다시 불리지 않는다', () => {
    const spy = vi.spyOn(usePeakWallCountsRegistry.getState(), 'register');
    const Harness = ({ applicable }: { applicable: boolean }) => {
      usePeakWallCountsPublisher(null, applicable, input());
      return null;
    };
    const view = render(<Harness applicable />);
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBe(6);

    // 개수는 그대로, 객체 참조만 새로운 재렌더 3회 — 여기서 늘면 유출이다.
    view.rerender(<Harness applicable />);
    view.rerender(<Harness applicable />);
    view.rerender(<Harness applicable />);
    expect(spy.mock.calls.length).toBe(afterFirst);

    spy.mockRestore();
    view.unmount();
  });

  it('applicable 이 false 가 되면 엔트리가 사라진다 (0 으로 남지 않는다)', () => {
    const Harness = ({ applicable }: { applicable: boolean }) => {
      usePeakWallCountsPublisher(null, applicable, input());
      return null;
    };
    const view = render(<Harness applicable />);
    expect(usePeakWallCountsRegistry.getState().byScope.get(null)?.get('ask-traded'))
      .toEqual({ shown: 1, hiddenByFilter: 2 });

    view.rerender(<Harness applicable={false} />);
    expect(usePeakWallCountsRegistry.getState().byScope.get(null)?.get('ask-traded'))
      .toBeUndefined();
    view.unmount();
  });
});

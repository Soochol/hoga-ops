import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useClampedFixedPosition } from './useClampedFixedPosition';

/**
 * **레이어는 뜬 뒤에 자란다.** 클램프를 마운트 한 번으로 끝내면 나중에 붙는 내용이
 * 뷰포트 밖으로 밀린다 — 관심종목 추가 팝오버의 중복 안내 배너가 그렇게 잘렸다
 * (실측 bottom 779 > 720). 그래서 이 훅은 **매 커밋에서** 다시 잰다.
 *
 * jsdom 은 레이아웃을 계산하지 않으므로 rect 는 손으로 준다 — 훅이 재는 값이 곧
 * 이 테스트의 입력이고, 그게 이 훅의 계약 전부다.
 */

let height = 40;
const VIEWPORT_H = 720;

function Harness({ x = 100, y = 700 }: { x?: number; y?: number }) {
  const [grown, setGrown] = useState(false);
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  return (
    <>
      <button onClick={() => { height = 150; setGrown(true); }}>자라기</button>
      <div ref={ref} data-testid="layer" data-grown={grown ? '' : undefined}
        style={{ position: 'fixed', left, top }} />
    </>
  );
}

describe('useClampedFixedPosition', () => {
  beforeEach(() => {
    cleanup();
    height = 40;
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(VIEWPORT_H);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 280, height } as DOMRect));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('레이어가 커지면 다시 클램프한다', () => {
    render(<Harness />);
    const layer = screen.getByTestId('layer');
    // 40px 짜리는 top 700 에 그대로 들어간다(700 + 40 = 740 > 720 이므로 680 으로 밀린다).
    expect(layer.style.top).toBe('680px');

    fireEvent.click(screen.getByText('자라기'));
    // 150px 이 되면 700 에 둘 수 없다 — 720 − 150 = 570.
    expect(layer.style.top).toBe('570px');
  });

  it('크기가 그대로면 위치를 다시 쓰지 않는다', () => {
    // 매 커밋 측정이 **무한 루프가 되지 않는다**는 것이 이 훅의 안전 조건이다.
    // 값이 같으면 setPos 를 아예 부르지 않아야 리렌더가 멎는다.
    const { rerender } = render(<Harness />);
    const before = screen.getByTestId('layer').style.top;
    rerender(<Harness />);
    rerender(<Harness />);
    expect(screen.getByTestId('layer').style.top).toBe(before);
  });

  it('오른쪽 가장자리에서 위치에 따라 폭·줄바꿈이 달라져도 수렴한다', () => {
    // auto 폭의 fixed 메뉴는 left에 따라 가용 폭과 높이가 바뀐다.
    // 소수점 위치에서 측정한 rect가 반복 보정의 입력이 되지 않아야 한다.
    const measure = vi.mocked(Element.prototype.getBoundingClientRect);
    measure.mockImplementation(function (this: HTMLElement) {
      const left = parseFloat(this.style.left);
      return { width: left > 999.9 ? 280.25 : 280, height: left > 999.9 ? 100 : 40 } as DOMRect;
    });
    render(<StrictMode><Harness x={1250.5} y={700.5} /></StrictMode>);
    const layer = screen.getByTestId('layer');
    expect(layer.style.left).toBe('1000px');
    expect(layer.style.top).toBe('680px');
    expect(measure.mock.calls.length).toBeLessThan(10);
  });

  it('측정 후 앵커 이동과 메뉴 크기 변화를 함께 반영한다', () => {
    const { rerender } = render(<Harness x={1250} />);
    const layer = screen.getByTestId('layer');
    expect(layer.style.left).toBe('1000px');
    height = 150;
    rerender(<Harness x={50.5} y={100.25} />);
    expect(layer.style.left).toBe('50.5px');
    expect(layer.style.top).toBe('100.25px');
    rerender(<Harness x={1250} y={700} />);
    expect(layer.style.left).toBe('1000px');
    expect(layer.style.top).toBe('570px');
  });
});

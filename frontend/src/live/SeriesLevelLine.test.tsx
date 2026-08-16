import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import SeriesLevelLine from './SeriesLevelLine';

/** LiveCurrentPriceLine.test.tsx 와 같은 모양 — price line 핸들의 applyOptions 를 센다. */
function makeSeriesMock() {
  const priceLine = { applyOptions: vi.fn() };
  return { priceLine, createPriceLine: vi.fn(() => priceLine), removePriceLine: vi.fn() };
}

const BASE = { color: '#F04452', lineWidth: 1, lineStyle: 'solid', enabled: true } as const;

describe('SeriesLevelLine — series 가 값보다 늦게 도착하는 순서', () => {
  beforeEach(cleanup);

  // #1338 의 red-check. `/study` 가 정확히 이 순서다: 번들이 react-query 캐시에서
  // 이미 완성된 채 첫 렌더에 들어오고(=price 는 그때 최종값), pane primary series 는
  // 자식 effect 로 **한 커밋 뒤에** 올라온다. 생성 effect 만 [series] 를 보므로 라인은
  // 그때 태어나지만, update effect 는 deps 가 하나도 안 변해 다시 돌지 않는다 →
  // 라인이 생성 기본값(price 0 · lineVisible false)에 영구 고착된다.
  // `/live` 는 SSE 틱이 price 를 계속 흔들어 이 구멍을 가려 왔다.
  it('series 가 나중에 붙어도 라인을 드러낸다', () => {
    const s = makeSeriesMock();
    const { rerender } = render(
      <SeriesLevelLine {...BASE} series={undefined} price={12_345} />,
    );
    expect(s.createPriceLine).not.toHaveBeenCalled();

    // 움직이는 변수는 series 하나뿐 — price/색/스타일/enabled 는 그대로다.
    rerender(<SeriesLevelLine {...BASE} series={s as never} price={12_345} />);

    expect(s.createPriceLine).toHaveBeenCalledTimes(1);
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ price: 12_345, lineVisible: true, axisLabelVisible: true }),
    );
  });

  // 대조군. 이 케이스는 수정 **전에도** 통과한다 — 그래서 위 실패가 "수평선 기능 전체"
  // 가 아니라 **늦게 오는 series 순서**의 결함임이 못박힌다.
  it('대조군: series 가 처음부터 있으면 종전대로 드러난다', () => {
    const s = makeSeriesMock();
    render(<SeriesLevelLine {...BASE} series={s as never} price={12_345} />);
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ price: 12_345, lineVisible: true }),
    );
  });

  it('series 가 늦게 오고 enabled=false 면 숨긴 채로 둔다', () => {
    const s = makeSeriesMock();
    const { rerender } = render(
      <SeriesLevelLine {...BASE} enabled={false} series={undefined} price={12_345} />,
    );
    rerender(<SeriesLevelLine {...BASE} enabled={false} series={s as never} price={12_345} />);
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ lineVisible: false }),
    );
  });

  it('series 핸들이 교체되면 새 라인에 현재값을 다시 적용한다', () => {
    const a = makeSeriesMock();
    const b = makeSeriesMock();
    const { rerender } = render(<SeriesLevelLine {...BASE} series={a as never} price={100} />);
    rerender(<SeriesLevelLine {...BASE} series={b as never} price={100} />);
    expect(a.removePriceLine).toHaveBeenCalledTimes(1);
    expect(b.createPriceLine).toHaveBeenCalledTimes(1);
    expect(b.priceLine.applyOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ price: 100, lineVisible: true }),
    );
  });
});

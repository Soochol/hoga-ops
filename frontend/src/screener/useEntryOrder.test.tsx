import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useEntryOrder } from './useEntryOrder';
import { stackByEntryOrder } from './sortResults';

/** 훅이 돌려준 rank 맵을 실제 표시 순서로 환산(codes 는 서버 순서). */
const display = (codes: string[], map: ReadonlyMap<string, number>) =>
  stackByEntryOrder(codes.map((code) => ({ code })), map).map((r) => r.code);

type Props = { codes: string[]; resetKey: string | null };

function render(initial: Props) {
  return renderHook(({ codes, resetKey }: Props) => useEntryOrder(codes, resetKey), {
    initialProps: initial,
  });
}

describe('useEntryOrder', () => {
  it('첫 배치는 서버 순서를 그대로 유지한다', () => {
    const { result } = render({ codes: ['A', 'B', 'C'], resetKey: 'k1' });
    expect(display(['A', 'B', 'C'], result.current)).toEqual(['A', 'B', 'C']);
  });

  it('신규 편입 종목을 서버 순서대로 상단에 쌓는다', () => {
    const { result, rerender } = render({ codes: ['A', 'B'], resetKey: 'k1' });
    act(() => { rerender({ codes: ['X', 'A', 'B', 'Y'], resetKey: 'k1' }); }); // X·Y 신규
    // 신규 X·Y 가 위(서버순 X→Y), 기존 A·B 는 아래(진입순 고정).
    expect(display(['X', 'A', 'B', 'Y'], result.current)).toEqual(['X', 'Y', 'A', 'B']);
  });

  it('멤버십이 같으면 서버가 순서를 바꿔도 위치를 고정한다', () => {
    const { result, rerender } = render({ codes: ['A', 'B', 'C'], resetKey: 'k1' });
    act(() => { rerender({ codes: ['C', 'B', 'A'], resetKey: 'k1' }); }); // 서버가 뒤집어 내려도
    expect(display(['C', 'B', 'A'], result.current)).toEqual(['A', 'B', 'C']);
  });

  it('이탈 후 재편입한 종목은 새 rank 로 상단에 온다', () => {
    const { result, rerender } = render({ codes: ['A', 'B', 'C'], resetKey: 'k1' });
    act(() => { rerender({ codes: ['A', 'B'], resetKey: 'k1' }); });        // C 이탈
    act(() => { rerender({ codes: ['A', 'B', 'C'], resetKey: 'k1' }); });   // C 재편입
    expect(display(['A', 'B', 'C'], result.current)).toEqual(['C', 'A', 'B']);
  });

  it('resetKey 가 바뀌면 진입 이력을 초기화한다', () => {
    const { result, rerender } = render({ codes: ['A', 'B', 'C'], resetKey: 'k1' });
    // 조건 전환 + 새 서버 순서: 이력 폐기 후 새 배치로 다시 굳는다.
    act(() => { rerender({ codes: ['C', 'B', 'A'], resetKey: 'k2' }); });
    expect(display(['C', 'B', 'A'], result.current)).toEqual(['C', 'B', 'A']);
  });
});

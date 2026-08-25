import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useThrottledValue } from './useThrottledValue';

const MS = 10_000;
const FLUSH_MS = 150; // liveTickOverlay 의 WS 틱 코얼레싱 간격 — 창 안 갱신의 실제 리듬

/** 커밋 시퀀스 수집 하니스. 렌더 횟수가 아니라 **값이 실제로 바뀐 횟수**를 센다 —
 *  스로틀의 계약은 "몇 번 렌더되나" 가 아니라 "화면에 몇 개의 값이 나타나나" 다.
 *  훅 결과의 flush 도 넘겨줘 flush 계약 테스트가 같은 커밋 시퀀스로 단언한다. */
function trackCommits<T>(initial: T, intervalMs = MS) {
  const commits: T[] = [];
  const view = renderHook(({ v }) => {
    const [out, flush] = useThrottledValue(v, intervalMs);
    if (commits.length === 0 || !Object.is(commits[commits.length - 1], out)) commits.push(out);
    return [out, flush] as const;
  }, { initialProps: { v: initial } });
  return { ...view, commits, flush: () => view.result.current[1]() };
}

describe('useThrottledValue', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

  it('마운트는 창을 열지 않는다 — 첫 변화가 즉시 통과(leading)', () => {
    // 이게 깨지면 콜드 로드에서 첫 시세(빈 Map → 채워진 Map)가 창에 갇혀
    // 정렬이 intervalMs 동안 초기 상태로 보인다.
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, MS), {
      initialProps: { v: 'a' },
    });
    expect(result.current[0]).toBe('a');
    act(() => { rerender({ v: 'b' }); }); // 타이머를 전혀 진행시키지 않았다
    expect(result.current[0]).toBe('b');
  });

  it('창 안 갱신은 모였다가 최신값 1회로 커밋 — 중간값은 화면에 오지 않는다', () => {
    const { rerender, commits } = trackCommits('a');
    act(() => { rerender({ v: 'b' }); });                            // leading
    for (const v of ['c', 'd', 'e']) act(() => { rerender({ v }); }); // 창 안
    expect(commits).toEqual(['a', 'b']);
    act(() => { vi.advanceTimersByTime(MS); });
    expect(commits).toEqual(['a', 'b', 'e']); // c·d 는 건너뛰고 최신값만
  });

  it('창 안에서 20회 갱신해도 커밋은 leading+trailing 2회뿐', () => {
    // 벽시계 비율이 아니라 커밋 **횟수**로 단언한다(리포 관례: 타이밍 flake 회피).
    const { rerender, commits } = trackCommits(0);
    for (let i = 1; i <= 20; i += 1) {
      act(() => { rerender({ v: i }); vi.advanceTimersByTime(FLUSH_MS); });
    }
    expect(commits).toEqual([0, 1]); // 3초 동안 20번 바뀌었지만 화면은 1번만 움직였다
    act(() => { vi.advanceTimersByTime(MS); });
    expect(commits).toEqual([0, 1, 20]);
  });

  it('창이 닫힌 뒤의 변화는 다시 즉시 통과', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, MS), {
      initialProps: { v: 'a' },
    });
    act(() => { rerender({ v: 'b' }); });
    act(() => { vi.advanceTimersByTime(MS); }); // 창 종료(예약된 trailing 없음)
    act(() => { rerender({ v: 'c' }); });
    expect(result.current[0]).toBe('c');
  });

  it('동일 값 재렌더는 창을 열지 않는다 — 이후 첫 변화가 여전히 즉시', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, MS), {
      initialProps: { v: 'a' },
    });
    act(() => { rerender({ v: 'a' }); });
    act(() => { rerender({ v: 'a' }); });
    act(() => { rerender({ v: 'b' }); });
    expect(result.current[0]).toBe('b');
  });

  it('창 안에 여러 번 갱신돼도 trailing 예약은 미뤄지지 않는다', () => {
    // 갱신마다 타이머를 다시 걸면(디바운스) 갱신이 끊기지 않는 장중에는 커밋이 영영
    // 오지 않는다. 스로틀은 첫 예약 시각을 지킨다.
    const { rerender, commits } = trackCommits('a');
    act(() => { rerender({ v: 'b' }); });                  // leading, 창 시작(t=0)
    act(() => { vi.advanceTimersByTime(MS / 2); });
    act(() => { rerender({ v: 'c' }); });                  // t=5000 에 갱신
    act(() => { vi.advanceTimersByTime(MS / 2); });        // t=10000 — 최초 창 종료 시각
    expect(commits).toEqual(['a', 'b', 'c']);
  });

  it('언마운트 시 예약된 trailing 타이머를 정리한다', () => {
    const { rerender, unmount } = renderHook(({ v }) => useThrottledValue(v, MS), {
      initialProps: { v: 'a' },
    });
    act(() => { rerender({ v: 'b' }); }); // leading
    act(() => { rerender({ v: 'c' }); }); // trailing 예약
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  // --- flush — 정렬 버튼 클릭이 스로틀을 우회하는 경로 ------------------------

  it('flush 는 대기 중인 최신값을 즉시 커밋하고 예약된 trailing 을 취소한다(이중 커밋 없음)', () => {
    const { rerender, commits, flush } = trackCommits('a');
    act(() => { rerender({ v: 'b' }); });                  // leading, 창 시작
    for (const v of ['c', 'd']) act(() => { rerender({ v }); }); // 창 안 — trailing 예약
    act(() => { flush(); });
    expect(commits).toEqual(['a', 'b', 'd']);              // 창이 닫히길 기다리지 않았다
    expect(vi.getTimerCount()).toBe(0);                    // trailing 취소 —
    act(() => { vi.advanceTimersByTime(MS * 2); });
    expect(commits).toEqual(['a', 'b', 'd']);              // — 뒤늦은 재커밋이 없다
  });

  it('flush 가 커밋하면 거기서 새 창이 열린다 — 이후 갱신은 다시 스로틀', () => {
    const { rerender, commits, flush } = trackCommits('a');
    act(() => { rerender({ v: 'b' }); });  // leading
    act(() => { rerender({ v: 'c' }); });  // 창 안
    act(() => { flush(); });               // 'c' 즉시 커밋 + 새 창
    act(() => { rerender({ v: 'd' }); });  // flush 직후 갱신 — 통과하면 안 된다
    expect(commits).toEqual(['a', 'b', 'c']);
    act(() => { vi.advanceTimersByTime(MS); });
    expect(commits).toEqual(['a', 'b', 'c', 'd']); // 새 창의 trailing 으로 도착
  });

  it('커밋할 것이 없는 flush 는 완전한 no-op — 마운트 직후 flush 뒤에도 첫 변화는 leading', () => {
    // 소비자(정렬 모드 구독 이펙트)는 마운트에서도 flush 를 부른다. 여기서 창이 열리면
    // 콜드 로드의 첫 실데이터(빈 Map → 시세)가 intervalMs 동안 갇힌다 — "마운트는 창을
    // 열지 않는다" 테스트가 지키는 회귀를 flush 경유로 재생산하지 않는지 검사한다.
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, MS), {
      initialProps: { v: 'a' },
    });
    act(() => { result.current[1](); });   // 마운트 직후 flush — 커밋할 것이 없다
    act(() => { rerender({ v: 'b' }); });  // 타이머를 전혀 진행시키지 않았다
    expect(result.current[0]).toBe('b');   // 여전히 leading 으로 즉시 통과
  });
});

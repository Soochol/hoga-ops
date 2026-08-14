import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useThrottledValue } from './useThrottledValue';

const MS = 10_000;
const FLUSH_MS = 150; // liveTickOverlay 의 WS 틱 코얼레싱 간격 — 창 안 갱신의 실제 리듬

/** 커밋 시퀀스 수집 하니스. 렌더 횟수가 아니라 **값이 실제로 바뀐 횟수**를 센다 —
 *  스로틀의 계약은 "몇 번 렌더되나" 가 아니라 "화면에 몇 개의 값이 나타나나" 다. */
function trackCommits<T>(initial: T, intervalMs = MS) {
  const commits: T[] = [];
  const view = renderHook(({ v }) => {
    const out = useThrottledValue(v, intervalMs);
    if (commits.length === 0 || !Object.is(commits[commits.length - 1], out)) commits.push(out);
    return out;
  }, { initialProps: { v: initial } });
  return { ...view, commits };
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
    expect(result.current).toBe('a');
    act(() => { rerender({ v: 'b' }); }); // 타이머를 전혀 진행시키지 않았다
    expect(result.current).toBe('b');
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
    expect(result.current).toBe('c');
  });

  it('동일 값 재렌더는 창을 열지 않는다 — 이후 첫 변화가 여전히 즉시', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, MS), {
      initialProps: { v: 'a' },
    });
    act(() => { rerender({ v: 'a' }); });
    act(() => { rerender({ v: 'a' }); });
    act(() => { rerender({ v: 'b' }); });
    expect(result.current).toBe('b');
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
});

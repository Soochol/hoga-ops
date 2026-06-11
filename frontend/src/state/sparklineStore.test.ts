import { it, expect, beforeEach } from 'vitest';
import { useSparklineStore, MAX_POINTS } from './sparklineStore';

// KST 날짜는 unixMsToKSTDate(ms)=new Date(ms+9h). UTC 01:00 → KST 10:00 같은 날.
const DAY1 = Date.UTC(2026, 5, 10, 1, 0, 0); // 20260610 10:00 KST
const DAY2 = Date.UTC(2026, 5, 11, 1, 0, 0); // 20260611 10:00 KST

beforeEach(() => useSparklineStore.getState().reset());

it('append: 코드별로 값이 시계열로 쌓인다', () => {
  const { appendBatch } = useSparklineStore.getState();
  appendBatch([{ code: 'A', value: 1 }], DAY1);
  appendBatch([{ code: 'A', value: 2 }], DAY1);
  expect(useSparklineStore.getState().series.get('A')).toEqual([1, 2]);
});

it('cap: MAX_POINTS를 넘으면 가장 오래된 점이 밀린다', () => {
  const { appendBatch } = useSparklineStore.getState();
  for (let i = 0; i < MAX_POINTS + 5; i++) appendBatch([{ code: 'A', value: i }], DAY1);
  const arr = useSparklineStore.getState().series.get('A')!;
  expect(arr.length).toBe(MAX_POINTS);
  expect(arr[arr.length - 1]).toBe(MAX_POINTS + 4); // 마지막 값 보존
  expect(arr[0]).toBe(5);                            // 0..4 evict
});

it('KST 날짜 롤오버: 다음 거래일이면 시계열 초기화', () => {
  const { appendBatch } = useSparklineStore.getState();
  appendBatch([{ code: 'A', value: 1 }], DAY1);
  appendBatch([{ code: 'A', value: 9 }], DAY2);
  expect(useSparklineStore.getState().series.get('A')).toEqual([9]);
});

it('prune: 이번 배치에 없는 코드는 사라진다(watchlist 축소)', () => {
  const { appendBatch } = useSparklineStore.getState();
  appendBatch([{ code: 'A', value: 1 }, { code: 'B', value: 1 }], DAY1);
  appendBatch([{ code: 'A', value: 2 }], DAY1);
  const s = useSparklineStore.getState().series;
  expect(s.has('A')).toBe(true);
  expect(s.has('B')).toBe(false);
});

it('carry-forward: 값 null이면 점은 안 늘리고 기존 시계열 보존', () => {
  const { appendBatch } = useSparklineStore.getState();
  appendBatch([{ code: 'A', value: 1 }], DAY1);
  appendBatch([{ code: 'A', value: null }], DAY1);  // 일시적 결측(여전히 watchlist)
  expect(useSparklineStore.getState().series.get('A')).toEqual([1]); // [1,1] 아님
});

it('carry-forward: 첫 폴부터 null이면 빈 배열로 Map을 오염시키지 않는다', () => {
  const { appendBatch } = useSparklineStore.getState();
  appendBatch([{ code: 'A', value: null }], DAY1);
  expect(useSparklineStore.getState().series.has('A')).toBe(false);
});

import { describe, it, expect, vi } from 'vitest';
import type { SeriesDataItemTypeMap, SeriesType, UTCTimestamp } from 'lightweight-charts';
import { classifyDataChange, syncSeriesData, type SeriesDataSink } from './seriesDataDiff';

type SeriesItem = SeriesDataItemTypeMap[SeriesType];

// lightweight-charts brands `time` (UTCTimestamp = number & {…}); the runtime
// value is a plain number. Cast small integers through `t()` so the literals
// satisfy the SeriesItem union without `any`.
const t = (n: number) => n as UTCTimestamp;
const L = (time: number, value: number, color?: string): SeriesItem =>
  (color === undefined ? { time: t(time), value } : { time: t(time), value, color }) as SeriesItem;
const W = (time: number): SeriesItem => ({ time: t(time) }) as SeriesItem; // whitespace
const C = (time: number, c: number): SeriesItem =>
  ({ time: t(time), open: 1, high: 2, low: 0, close: c }) as SeriesItem;

describe('classifyDataChange — generic tail-diff (P2: setData vs update 결정)', () => {
  it('이전 배열 없음(첫 push) → setData', () => {
    expect(classifyDataChange(null, [L(1, 10)])).toEqual({ kind: 'setData' });
  });

  it('완전 동일 → skip (중복 push 회피)', () => {
    const a = [L(1, 10), L(2, 20), L(3, 30)];
    const b = [L(1, 10), L(2, 20), L(3, 30)];
    expect(classifyDataChange(a, b)).toEqual({ kind: 'skip' });
  });

  it('마지막 값만 변경(같은 버킷, 새 체결) → update(마지막)', () => {
    const a = [L(1, 10), L(2, 20), L(3, 30)];
    const b = [L(1, 10), L(2, 20), L(3, 31)];
    expect(classifyDataChange(a, b)).toEqual({ kind: 'update', point: L(3, 31) });
  });

  it('마지막 1개 append(새 버킷) + prefix 동일 → update(append된 것)', () => {
    const a = [L(1, 10), L(2, 20)];
    const b = [L(1, 10), L(2, 20), L(3, 30)];
    expect(classifyDataChange(a, b)).toEqual({ kind: 'update', point: L(3, 30) });
  });

  it('이전 원소가 변경됨(경매 마스킹 소급 color 재작성) → setData 폴백', () => {
    // 마지막 + 직전 원소의 color가 함께 바뀜(maskOutgoingConnector 패턴)
    const a = [L(1, 10), L(2, 20), L(3, 30)];
    const b = [L(1, 10), L(2, 20, 'transparent'), L(3, 30)]; // 직전 color 변경
    expect(classifyDataChange(a, b)).toEqual({ kind: 'setData' });
  });

  it('마지막 원소 color만 변경 → update (color도 비교 대상)', () => {
    const a = [L(1, 10), L(2, 20), L(3, 30)];
    const b = [L(1, 10), L(2, 20), L(3, 30, 'red')];
    expect(classifyDataChange(a, b)).toEqual({ kind: 'update', point: L(3, 30, 'red') });
  });

  it('2개 이상 append(일경계: whitespace+zero anchor+점) → setData 폴백', () => {
    const a = [L(1, 10), L(2, 20)];
    const b = [L(1, 10), L(2, 20), W(3), L(3, 0), L(4, 5)];
    expect(classifyDataChange(a, b)).toEqual({ kind: 'setData' });
  });

  it('길이 축소 → setData 폴백', () => {
    const a = [L(1, 10), L(2, 20), L(3, 30)];
    const b = [L(1, 10), L(2, 20)];
    expect(classifyDataChange(a, b)).toEqual({ kind: 'setData' });
  });

  it('마지막이 whitespace로 바뀌면 update 안 함 → setData (whitespace update 위험 회피)', () => {
    const a = [L(1, 10), L(2, 20), L(3, 30)];
    const b = [L(1, 10), L(2, 20), W(3)];
    expect(classifyDataChange(a, b)).toEqual({ kind: 'setData' });
  });

  it('append된 마지막이 whitespace → setData', () => {
    const a = [L(1, 10), L(2, 20)];
    const b = [L(1, 10), L(2, 20), W(3)];
    expect(classifyDataChange(a, b)).toEqual({ kind: 'setData' });
  });

  it('빈 배열 → 빈 배열: skip; 비어있다 채워지면 setData', () => {
    expect(classifyDataChange([], [])).toEqual({ kind: 'skip' });
    expect(classifyDataChange([], [L(1, 10)])).toEqual({ kind: 'setData' });
    expect(classifyDataChange([L(1, 10)], [])).toEqual({ kind: 'setData' });
  });

  it('past 원소는 참조 동일(===)이면 값비교 생략하고 통과 — 당일 마지막만 변경', () => {
    // P0 캐시: past 원소는 틱 간 같은 객체 참조. 동일 ref 공유 + 당일 끝만 변경.
    const past = [L(1, 10), L(2, 20)]; // 같은 객체 참조 재사용
    const a = [...past, L(3, 30)];
    const b = [...past, L(3, 33)]; // past 참조 동일, 마지막만 변경
    expect(classifyDataChange(a, b)).toEqual({ kind: 'update', point: L(3, 33) });
  });

  it('같은 길이지만 마지막 time이 바뀌면 → setData (update는 replace 아닌 append → phantom bar)', () => {
    // series.update({time:3})이 현재 마지막 time(2)보다 크면 lwc가 append → 시리즈가
    // n+1개로 늘어 내부 모델(n개)과 어긋난다. same-length 변경은 time이 같을 때만 update.
    const a = [L(1, 10), L(2, 20)];
    const b = [L(1, 10), L(3, 20)]; // 마지막 time 2→3
    expect(classifyDataChange(a, b)).toEqual({ kind: 'setData' });
  });

  it('candle: OHLC 중 하나만(마지막) 바뀜 → update', () => {
    const a = [C(1, 1), C(2, 2)];
    const b = [C(1, 1), C(2, 3)];
    expect(classifyDataChange(a, b)).toEqual({ kind: 'update', point: C(2, 3) });
  });
});

// syncSeriesData 는 결정 + 적용 + 캐시를 한 seam에 모은다. 예전엔 적용/캐시가
// RangeSeriesPane 의 effect 안에 있어 브라우저 전용 증거였으나, fake sink 로 "어느
// lwc 메서드가 어떤 인자로 호출됐는가 + 다음 캐시 값"을 직접 검증한다.
describe('syncSeriesData — 결정·적용·캐시 한 seam', () => {
  function fakeSink() {
    const sink: SeriesDataSink = { setData: vi.fn(), update: vi.fn() };
    return sink as SeriesDataSink & { setData: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  }

  it('skip: sink 미호출 + 캐시는 prev 그대로(시리즈가 이미 들고 있음)', () => {
    const sink = fakeSink();
    const prev = [L(1, 10), L(2, 20)];
    const next = [L(1, 10), L(2, 20)];
    const cached = syncSeriesData(sink, prev, next);
    expect(sink.setData).not.toHaveBeenCalled();
    expect(sink.update).not.toHaveBeenCalled();
    expect(cached).toBe(prev); // next 가 아니라 prev — 캐시 불변
  });

  it('update(tail): sink.update(마지막) 호출 + 캐시는 next', () => {
    const sink = fakeSink();
    const prev = [L(1, 10), L(2, 20), L(3, 30)];
    const next = [L(1, 10), L(2, 20), L(3, 31)];
    const cached = syncSeriesData(sink, prev, next);
    expect(sink.update).toHaveBeenCalledTimes(1);
    expect(sink.update).toHaveBeenCalledWith(L(3, 31));
    expect(sink.setData).not.toHaveBeenCalled();
    expect(cached).toBe(next);
  });

  it('setData(첫 push, prev=null): sink.setData(next) 호출 + 캐시는 next', () => {
    const sink = fakeSink();
    const next = [L(1, 10)];
    const cached = syncSeriesData(sink, null, next);
    expect(sink.setData).toHaveBeenCalledTimes(1);
    expect(sink.setData).toHaveBeenCalledWith(next);
    expect(sink.update).not.toHaveBeenCalled();
    expect(cached).toBe(next);
  });

  it('setData(폴백, 이전 원소 변경): sink.setData(next) 호출 + 캐시는 next', () => {
    const sink = fakeSink();
    const prev = [L(1, 10), L(2, 20), L(3, 30)];
    const next = [L(1, 10), L(2, 20, 'transparent'), L(3, 30)]; // 직전 color 변경
    const cached = syncSeriesData(sink, prev, next);
    expect(sink.setData).toHaveBeenCalledWith(next);
    expect(sink.update).not.toHaveBeenCalled();
    expect(cached).toBe(next);
  });

  it('연속 호출: update 후 또 skip이면 캐시가 update의 next 를 유지', () => {
    const sink = fakeSink();
    const a = [L(1, 10), L(2, 20)];
    const b = [L(1, 10), L(2, 21)];
    let cache = syncSeriesData(sink, a, b);       // update → cache=b
    expect(cache).toBe(b);
    cache = syncSeriesData(sink, cache ?? null, b); // 동일 → skip → cache=b 유지
    expect(cache).toBe(b);
    expect(sink.update).toHaveBeenCalledTimes(1);
  });
});

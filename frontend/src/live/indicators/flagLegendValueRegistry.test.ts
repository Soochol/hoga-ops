import { describe, it, expect, afterEach } from 'vitest';
import {
  clearWindowFlagLegendValues,
  readFlagLegendValues,
  registerFlagLegendValues,
  unregisterFlagLegendValues,
  type FlagLegendValueProvider,
} from './flagLegendValueRegistry';

const cell = (value: string): FlagLegendValueProvider => () => [{ key: 'k', value }];

afterEach(() => {
  clearWindowFlagLegendValues('w1');
  clearWindowFlagLegendValues('w2');
});

describe('flagLegendValueRegistry — 창 스코프(#706)', () => {
  it('같은 flag id 를 창별로 독립 보관한다', () => {
    registerFlagLegendValues('w1', 'ask-peak', cell('A'));
    registerFlagLegendValues('w2', 'ask-peak', cell('B'));
    expect(readFlagLegendValues('w1', 'ask-peak', null)).toEqual([{ key: 'k', value: 'A' }]);
    expect(readFlagLegendValues('w2', 'ask-peak', null)).toEqual([{ key: 'k', value: 'B' }]);
  });

  it('전역(null) 스코프는 창 스코프와 별개다', () => {
    const global = cell('G');
    registerFlagLegendValues(null, 'ask-peak', global);
    registerFlagLegendValues('w1', 'ask-peak', cell('A'));
    try {
      expect(readFlagLegendValues(null, 'ask-peak', null)).toEqual([{ key: 'k', value: 'G' }]);
      expect(readFlagLegendValues('w1', 'ask-peak', null)).toEqual([{ key: 'k', value: 'A' }]);
    } finally {
      unregisterFlagLegendValues(null, 'ask-peak', global);
    }
  });

  it('미등록 (창, flag) 는 빈 배열', () => {
    expect(readFlagLegendValues('w1', 'depth-heatmap', null)).toEqual([]);
  });

  it('unregister 는 같은 창의 자기 provider 일 때만 지운다(identity guard)', () => {
    const stale = cell('stale');
    const fresh = cell('fresh');
    registerFlagLegendValues('w1', 'ask-peak', stale);
    registerFlagLegendValues('w1', 'ask-peak', fresh); // 재등록으로 교체
    // 이전 effect 의 뒤늦은 cleanup 이 신선한 등록을 걷어내면 안 된다.
    unregisterFlagLegendValues('w1', 'ask-peak', stale);
    expect(readFlagLegendValues('w1', 'ask-peak', null)).toEqual([{ key: 'k', value: 'fresh' }]);
    unregisterFlagLegendValues('w1', 'ask-peak', fresh);
    expect(readFlagLegendValues('w1', 'ask-peak', null)).toEqual([]);
  });

  it('다른 창 이름으로 unregister 해도 지워지지 않는다', () => {
    const p = cell('A');
    registerFlagLegendValues('w1', 'ask-peak', p);
    unregisterFlagLegendValues('w2', 'ask-peak', p);
    expect(readFlagLegendValues('w1', 'ask-peak', null)).toEqual([{ key: 'k', value: 'A' }]);
  });

  it('창 정리는 그 창의 모든 flag 만 버린다', () => {
    registerFlagLegendValues('w1', 'ask-peak', cell('A1'));
    registerFlagLegendValues('w1', 'broker-late-entry', cell('A2'));
    registerFlagLegendValues('w2', 'ask-peak', cell('B1'));
    clearWindowFlagLegendValues('w1');
    expect(readFlagLegendValues('w1', 'ask-peak', null)).toEqual([]);
    expect(readFlagLegendValues('w1', 'broker-late-entry', null)).toEqual([]);
    expect(readFlagLegendValues('w2', 'ask-peak', null)).toEqual([{ key: 'k', value: 'B1' }]);
  });

  it('provider 가 던져도 레전드 렌더 프레임을 죽이지 않는다', () => {
    registerFlagLegendValues('w1', 'ask-peak', () => {
      throw new Error('boom');
    });
    expect(readFlagLegendValues('w1', 'ask-peak', null)).toEqual([]);
  });
});

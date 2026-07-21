import { describe, it, expect } from 'vitest';

import { krxTickSize, viExpectedDown, viExpectedUp } from './krxTick';

describe('krxTickSize', () => {
  it('2023 개편 가격대별 호가단위', () => {
    expect(krxTickSize(1_999)).toBe(1);
    expect(krxTickSize(2_000)).toBe(5);
    expect(krxTickSize(4_999)).toBe(5);
    expect(krxTickSize(5_000)).toBe(10);
    expect(krxTickSize(19_999)).toBe(10);
    expect(krxTickSize(20_000)).toBe(50);
    expect(krxTickSize(49_999)).toBe(50);
    expect(krxTickSize(50_000)).toBe(100);
    expect(krxTickSize(199_999)).toBe(100);
    expect(krxTickSize(200_000)).toBe(500);
    expect(krxTickSize(499_999)).toBe(500);
    expect(krxTickSize(500_000)).toBe(1_000);
  });
});

describe('viExpected', () => {
  it('상단 절사·하단 올림 — ka10001 상하한가 실검산과 같은 반올림 규칙', () => {
    // 삼성에스디에스 기준가 185,800: ×1.3=241,540→241,500(절사) ·
    // ×0.7=130,060→130,100(올림)이 실측 상하한가와 일치했던 규칙을 ±10% 에 적용.
    expect(viExpectedUp(185_800)).toBe(204_000); // 204,380 → tick 500 절사
    expect(viExpectedDown(185_800)).toBe(167_300); // 167,220 → tick 100 올림
  });

  it('실채록 VI 이벤트 기준가 검산(씨싸이트 3,490)', () => {
    // 실제 발동가 3,860 은 임계 통과 체결가(오버슈트) — 예상가는 임계 자체.
    expect(viExpectedUp(3_490)).toBe(3_835); // 3,839 → tick 5 절사
    expect(viExpectedDown(3_490)).toBe(3_145); // 3,141 → tick 5 올림
  });

  it('틱 밴드 경계를 결과 가격대로 판정한다', () => {
    // 기준가 1,900(밴드 1원) → ×1.1=2,090 은 2천원대(밴드 5원) 절사.
    expect(viExpectedUp(1_900)).toBe(2_090);
    expect(viExpectedDown(1_900)).toBe(1_710); // 1,710 밴드 1원
  });
});

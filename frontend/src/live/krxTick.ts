/**
 * KRX 주식 호가단위(2023-01 개편, KOSPI/KOSDAQ 공통)와 VI 예상 발동가 계산.
 *
 * 예상 발동가는 거래소·증권사 어느 API 도 주지 않는 계산값이다
 * (docs/research/2026-07-21-kiwoom-vi-price-sources.md). 정적VI 임계 = 기준가 ±10%
 * 를 호가단위로 반올림 — 방향별 반올림 규칙은 ka10001 상하한가 실검산에서 확정한
 * 것과 동일하다: 상단은 절사(185,800×1.3=241,540→241,500), 하단은 올림
 * (×0.7=130,060→130,100). 밴드 판정은 결과 가격대 기준.
 */

export function krxTickSize(price: number): number {
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

/** 상승VI 예상 발동가 = 기준가×1.1 을 호가단위로 절사. */
export function viExpectedUp(base: number): number {
  const raw = base * 1.1;
  const tick = krxTickSize(raw);
  return Math.floor(raw / tick) * tick;
}

/** 하강VI 예상 발동가 = 기준가×0.9 를 호가단위로 올림. */
export function viExpectedDown(base: number): number {
  const raw = base * 0.9;
  const tick = krxTickSize(raw);
  return Math.ceil(raw / tick) * tick;
}

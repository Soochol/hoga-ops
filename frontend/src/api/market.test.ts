/** 시장 종합 API 클라이언트 — 폴링 게이트 계약을 고정한다.
 *
 * 폴링 주기 자체는 벽시계로 재지 않는다(리포 규율) — **게이트가 언제 열리고 닫히는가**
 * 만 순수 함수로 검증한다. */
import { describe, expect, it } from 'vitest';
import { isMarketHours } from './market';

/** KST 로 해석되는 시각을 만든다 — 러너 TZ 에 의존하지 않기 위해 오프셋을 명시한다. */
function kst(y: number, m: number, d: number, hh: number, mm: number): Date {
  return new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`);
}

describe('isMarketHours', () => {
  it('정규장 안이면 연다 (09:00–15:30 KST)', () => {
    // 2026-08-05 는 수요일
    expect(isMarketHours(kst(2026, 8, 5, 9, 0))).toBe(true);
    expect(isMarketHours(kst(2026, 8, 5, 12, 0))).toBe(true);
    expect(isMarketHours(kst(2026, 8, 5, 15, 30))).toBe(true);
  });

  it('개장 전·마감 후는 닫는다', () => {
    expect(isMarketHours(kst(2026, 8, 5, 8, 59))).toBe(false);
    expect(isMarketHours(kst(2026, 8, 5, 15, 31))).toBe(false);
    expect(isMarketHours(kst(2026, 8, 5, 23, 0))).toBe(false);
  });

  it('주말은 장중 시각이어도 닫는다', () => {
    // 2026-08-08 토 · 08-09 일
    expect(isMarketHours(kst(2026, 8, 8, 11, 0))).toBe(false);
    expect(isMarketHours(kst(2026, 8, 9, 11, 0))).toBe(false);
  });

  it('휴장일은 거르지 않는다 — 프론트는 달력을 모른다', () => {
    // 게이트의 한계를 명시적으로 고정한다: 평일 공휴일에는 열린다(백엔드가
    // 빈 응답을 주고 last-good 이 유지되므로 화면은 깨지지 않는다).
    expect(isMarketHours(kst(2026, 8, 17, 11, 0))).toBe(true);
  });
});

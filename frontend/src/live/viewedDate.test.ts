import { describe, expect, it } from 'vitest';
import { viewedDateOf } from './viewedDate';

/** KST 자정 + n시간. */
const kst = (y: number, m: number, d: number, h = 9) =>
  Date.UTC(y, m - 1, d, h - 9);

const D1 = kst(2026, 8, 20, 9);
const D1_LAST = kst(2026, 8, 20, 15);
const D2 = kst(2026, 8, 21, 9);
const D2_LAST = kst(2026, 8, 21, 15);
const D3 = kst(2026, 8, 24, 9);
const D3_LAST = kst(2026, 8, 24, 15);
const CANDLES = [D1, D1_LAST, D2, D2_LAST, D3, D3_LAST].map((ts_ms) => ({ ts_ms }));

describe('viewedDateOf', () => {
  it('과거를 보고 있으면 **오른쪽 끝 봉**의 날짜를 말한다', () => {
    expect(viewedDateOf(CANDLES, D1_LAST)).toBe('20260820');
  });

  // 왼쪽이 어디든 보지 않는다 — 화면이 여러 날에 걸쳐도 답은 오른쪽 끝 하나다
  // (2026-08-22 사용자 결정의 앵커 규약: 저장뷰 착석·「분봉으로」 목적지와 같은 축).
  it('오른쪽 끝 봉만 본다 — 화면 왼쪽이 어디든', () => {
    expect(viewedDateOf(CANDLES, D2_LAST)).toBe('20260821');
    expect(viewedDateOf(CANDLES, D2)).toBe('20260821');
  });

  // 「오늘과 다른가」로 판정하면 주말·장 마감 뒤에 라이브 엣지에서도 칩이 뜬다 —
  // 아무것도 알려 주지 않으면서 상시 표시되는 상태가 된다.
  it('데이터의 끝에 있으면 말하지 않는다 — 오늘이 아니어도', () => {
    expect(viewedDateOf(CANDLES, D3_LAST)).toBeNull();
  });

  it('우측 여백을 보고 있어도 마지막 봉으로 떨어져 숨는다', () => {
    expect(viewedDateOf(CANDLES, D3_LAST + 5 * 3_600_000)).toBeNull();
  });

  // 같은 날 안에서 과거를 보는 것은 숨긴다 — 그 날은 데이터의 끝과 같은 날이고,
  // 사용자가 「지금 며칠인가」를 잃는 경우가 아니다.
  it('데이터 끝과 **같은 날**의 이른 시각은 말하지 않는다', () => {
    expect(viewedDateOf(CANDLES, D3)).toBeNull();
  });

  it('봉 사이 시각은 그 이하의 마지막 봉을 따른다', () => {
    expect(viewedDateOf(CANDLES, D1_LAST + 60_000)).toBe('20260820');
  });

  it('말할 것이 없으면 null — 캔들 없음 · 측정 불가 · 데이터보다 과거', () => {
    expect(viewedDateOf([], D1)).toBeNull();
    expect(viewedDateOf(CANDLES, null)).toBeNull();
    expect(viewedDateOf(CANDLES, Number.NaN)).toBeNull();
    expect(viewedDateOf(CANDLES, D1 - 86_400_000)).toBeNull();
  });
});

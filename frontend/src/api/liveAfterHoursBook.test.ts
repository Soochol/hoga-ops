import { describe, it, expect } from 'vitest';

import {
  afterHoursBookToSnapshot,
  isAfterHoursSinglePriceWindow,
  type LiveAfterHoursBookResponse,
} from './liveAfterHoursBook';

/** KST 시각 → Unix ms. 테스트가 **로컬 타임존과 무관**해야 하므로 UTC 로 지어서
 *  9시간을 뺀다 — 술어 자체가 그 변환을 하고 있어서, 여기서 로컬 Date 를 쓰면
 *  검사와 구현이 같은 실수를 공유하게 된다. */
const kst = (y: number, m: number, d: number, h: number, min: number): number =>
  Date.UTC(y, m - 1, d, h, min) - 9 * 3600 * 1000;

describe('isAfterHoursSinglePriceWindow', () => {
  // 2026-05-27 = 수요일, 2026-05-30/31 = 토/일.
  it('[16:00, 18:00) — 여는 쪽 포함, 닫는 쪽 배제', () => {
    expect(isAfterHoursSinglePriceWindow(kst(2026, 5, 27, 15, 59))).toBe(false);
    expect(isAfterHoursSinglePriceWindow(kst(2026, 5, 27, 16, 0))).toBe(true);
    expect(isAfterHoursSinglePriceWindow(kst(2026, 5, 27, 17, 59))).toBe(true);
    expect(isAfterHoursSinglePriceWindow(kst(2026, 5, 27, 18, 0))).toBe(false);
  });

  it('주말은 닫는다', () => {
    expect(isAfterHoursSinglePriceWindow(kst(2026, 5, 30, 17, 0))).toBe(false);
    expect(isAfterHoursSinglePriceWindow(kst(2026, 5, 31, 17, 0))).toBe(false);
  });

  it('백엔드 술어와 같은 경계다 — 손 미러의 드리프트 방지', () => {
    // hoga/live/session_gate.py::is_after_hours_single_price_window 와 같은 값.
    // 두 술어가 갈리면 프론트가 창 밖에서 폴링하거나(무의미한 왕복) 창 안에서
    // 안 돌아(화면이 빈다) — 후자가 조용해서 더 나쁘다.
    expect(isAfterHoursSinglePriceWindow(kst(2026, 5, 27, 16, 30))).toBe(true);
  });
});

const book = (over: Partial<LiveAfterHoursBookResponse> = {}): LiveAfterHoursBookResponse => ({
  code: '006360',
  active: true,
  base_tm: '164000',
  ask: [
    { price: 35_400, qty: 1_200 },
    { price: 35_450, qty: 800 },
    { price: 35_500, qty: 450 },
    { price: 0, qty: 0 },
    { price: 0, qty: 0 },
  ],
  bid: [
    { price: 35_350, qty: 2_100 },
    { price: 35_300, qty: 1_700 },
    { price: 0, qty: 0 },
    { price: 0, qty: 0 },
    { price: 0, qty: 0 },
  ],
  total_ask_qty: 2_450,
  total_bid_qty: 3_800,
  cur_price: 35_350,
  change_pct: -0.98,
  acc_volume: 12_345,
  fetched_at_ms: 1_700_000_000_000,
  source: 'kiwoom',
  ...over,
});

describe('afterHoursBookToSnapshot', () => {
  it('5단을 10칸으로 zero-pad 한다 — 격자 바깥 5행은 빈다', () => {
    const snap = afterHoursBookToSnapshot(book());

    expect(snap).not.toBeNull();
    expect(snap!.ask).toHaveLength(10);
    expect(snap!.bid).toHaveLength(10);
    expect(snap!.ask[0]).toEqual({ price: 35_400, qty: 1_200 });
    // index 5~9 는 벤더가 주지 않는 단계 — 결손이 아니라 **없는 단계**다.
    expect(snap!.ask[5]).toEqual({ price: 0, qty: 0 });
    expect(snap!.bid[9]).toEqual({ price: 0, qty: 0 });
  });

  it('총잔량은 시간외 단일가 값을 그대로 싣는다', () => {
    const snap = afterHoursBookToSnapshot(book());

    expect(snap!.tot_ask).toBe(2_450);
    expect(snap!.tot_bid).toBe(3_800);
  });

  it('active=false 면 null — 호출부가 정규장 스냅샷을 유지해야 한다', () => {
    // 창 밖·미거래 종목. 빈 호가창으로 갈아끼우면 화면이 오히려 나빠진다.
    expect(afterHoursBookToSnapshot(book({ active: false }))).toBeNull();
  });

  it('응답 자체가 없으면(로딩·503) null', () => {
    expect(afterHoursBookToSnapshot(undefined)).toBeNull();
  });
});

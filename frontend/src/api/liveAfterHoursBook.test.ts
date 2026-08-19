import { describe, it, expect } from 'vitest';

import {
  afterHoursBookToSnapshot,
  afterHoursFillRows,
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
  close_price: 35_350,
  exp_price: null,
  exp_qty: null,
  fills: [],
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

// ── 예상체결 (ka10001, 2026-08-19 실측) ──────────────────────────────────
//
// 여기 있던 `latestExpectedFill`(WS 0H) 테스트 묶음을 들어냈다. 그 함수가 삭제됐고,
// 삭제한 이유는 **소스가 존재하지 않기 때문**이다: 0H 는 이 창에 프레임을 하나도
// 내지 않는다(구독 중, 체결 3주기, 링버퍼 0건). 예상체결은 이제 응답이 싣고 온다.

describe('afterHoursBookToSnapshot — 예상체결', () => {
  it('응답의 exp_* 가 정규장 동시호가와 **같은 배너 필드**로 간다', () => {
    // 새 UI 를 만들지 않는다 — ExpectedFillBanner 가 이미 이 두 필드를 읽는다.
    // 출처만 다르다(정규장 0D FID 23/24 · 시간외 REST ka10001).
    const snap = afterHoursBookToSnapshot(book({ exp_price: 35_000, exp_qty: 2_198 }));

    expect(snap).toMatchObject({ exp_price: 35_000, exp_qty: 2_198 });
  });

  it('예상체결이 없으면 0 이라 배너가 뜨지 않는다', () => {
    // ka10001 만 실패했거나 그 종목에 시간외 주문이 없는 정상 상태다.
    expect(afterHoursBookToSnapshot(book())).toMatchObject({ exp_price: 0, exp_qty: 0 });
  });
});

describe('afterHoursFillRows', () => {
  const fills = [
    { t_ms: 1_787_123_427_000, price: 34_950, qty: 3_484 },
    { t_ms: 1_787_122_827_000, price: 34_900, qty: 1_255 },
  ];

  it('합성 체결을 체결창 행으로 옮긴다 — 순서는 백엔드가 준 대로(최신 먼저)', () => {
    const rows = afterHoursFillRows(book({ fills }));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ price: 34_950, qty: 3_484 });
  });

  it('side 는 항상 0 — 단일가 일괄 체결이라 **방향이 정의되지 않는다**', () => {
    // 0 을 "중립 체결"로 색칠하면 방향을 아는 것처럼 읽힌다. BookPanel 의 side>0/
    // side<0 분기 어디에도 걸리지 않는 값이어야 한다.
    expect(afterHoursFillRows(book({ fills })).every((r) => r.side === 0)).toBe(true);
  });

  it('active=false 면 빈 배열 — 그때 화면은 정규장 체결창을 그대로 쓴다', () => {
    expect(afterHoursFillRows(book({ active: false, fills }))).toEqual([]);
  });

  it('응답이 없으면 빈 배열', () => {
    expect(afterHoursFillRows(undefined)).toEqual([]);
  });

  it('관측이 없던 주기는 비는 것이 정상이다 — 없는 행을 만들지 않는다', () => {
    // 백엔드 `_FillLedger` 가 관측 공백에서 re-baseline 하므로 빈 배열이 온다.
    // 프론트가 그 자리를 메우려 들면 그쪽에서 막은 위조가 여기서 되살아난다.
    expect(afterHoursFillRows(book({ fills: [] }))).toEqual([]);
  });
});

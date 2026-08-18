import { describe, it, expect } from 'vitest';

import {
  afterHoursBookToSnapshot,
  isAfterHoursSinglePriceWindow,
  latestExpectedFill,
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

// ── 예상체결(키움 0H) (2026-08-18) ──────────────────────────────────────────

const expFrame = (t_ms: number, price: number, qty: number) => ({
  t_ms, kind: 'expected', code: '028050', venue: 'KRX',
  expected_price: price, expected_qty: qty,
});

describe('latestExpectedFill', () => {
  const inWindow = kst(2026, 5, 27, 16, 30);
  const closingAuction = kst(2026, 5, 27, 15, 25); // 정규장 종가 동시호가

  it('창 안의 마지막 프레임을 고른다', () => {
    expect(
      latestExpectedFill([expFrame(inWindow, 47_800, 100), expFrame(inWindow + 1000, 47_900, 250)]),
    ).toEqual({ price: 47_900, qty: 250 });
  });

  it('정규장 동시호가 프레임은 쓰지 않는다 — **이 테스트가 이 함수의 존재 이유다**', () => {
    // 게이트가 없으면 15:20–15:30 종가 동시호가의 마지막 0H 프레임이 버퍼에 남아
    // 16:30 화면에 실시간처럼 뜬다. 그건 ka10007 의 `exp_cntr_*` 가 이 구간에
    // 정규장 잔상을 답하던 것(2026-08-18 실측: 두 체결 주기에 걸쳐 미동)과 똑같은
    // 버그를 우리 손으로 재생산하는 것이다.
    expect(latestExpectedFill([expFrame(closingAuction, 47_900, 54_701)])).toBeNull();
  });

  it('창 안 프레임이 있으면 창 밖 최신 프레임보다 그것을 고른다', () => {
    // 배열 뒤쪽이 더 최신이지만 창 밖이다 — 순서가 아니라 **창 소속**이 판정한다.
    expect(
      latestExpectedFill([
        expFrame(inWindow, 47_800, 100),
        expFrame(kst(2026, 5, 27, 18, 30), 47_000, 999),
      ]),
    ).toEqual({ price: 47_800, qty: 100 });
  });

  it('값이 0 이거나 형이 다른 프레임은 건너뛴다', () => {
    expect(latestExpectedFill([expFrame(inWindow, 0, 100)])).toBeNull();
    expect(latestExpectedFill([expFrame(inWindow, 47_900, 0)])).toBeNull();
    expect(latestExpectedFill([{ t_ms: inWindow, kind: 'expected' }])).toBeNull();
    expect(latestExpectedFill([])).toBeNull();
  });
});

describe('afterHoursBookToSnapshot — 예상체결 주입', () => {
  it('0H 가 있으면 정규장 동시호가와 **같은 배너 필드**를 채운다', () => {
    // 새 UI 를 만들지 않는다 — ExpectedFillBanner 가 이미 이 두 필드를 읽는다.
    const snap = afterHoursBookToSnapshot(book(), { price: 47_900, qty: 250 });
    expect(snap).toMatchObject({ exp_price: 47_900, exp_qty: 250 });
  });

  it('0H 가 없으면 0 이라 배너가 뜨지 않는다', () => {
    const snap = afterHoursBookToSnapshot(book());
    expect(snap).toMatchObject({ exp_price: 0, exp_qty: 0 });
  });
});

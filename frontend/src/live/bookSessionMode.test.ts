import { describe, expect, it } from 'vitest';

import {
  bookSessionControl,
  bookSessionEpoch,
  defaultBookSessionMode,
  krxAfterHoursLabel,
  nxtPhaseLabel,
  otherBookSessionMode,
  resolveBookSessionMode,
} from './bookSessionMode';

/** KST 시각 → unix ms. 로컬 타임존과 무관하게 만든다 — 테스트가 CI/로컬에서
 *  다른 시각을 재면 경계 단언이 통째로 무의미해진다. */
function kst(yyyymmdd: string, hh: number, mm = 0): number {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  return Date.UTC(y, m - 1, d, hh - 9, mm);
}

// 2026-08-27 은 목요일(평일). 주말 판정이 끼어들지 않는 날을 고른다.
const DAY = '20260827';
const NEXT_DAY = '20260828';

describe('defaultBookSessionMode', () => {
  it('16:00 직전은 정규장', () => {
    expect(defaultBookSessionMode(kst(DAY, 15, 59))).toBe('regular');
  });

  it('16:00 정각에 시간외로 뒤집힌다', () => {
    expect(defaultBookSessionMode(kst(DAY, 16, 0))).toBe('afterHours');
  });

  it('18:00 이후에도 시간외 — 사다리는 얼어붙지만 보고 있는 장은 그대로다', () => {
    expect(defaultBookSessionMode(kst(DAY, 21, 30))).toBe('afterHours');
  });

  it('자정을 넘기면 정규장으로 복귀한다', () => {
    expect(defaultBookSessionMode(kst(NEXT_DAY, 0, 0))).toBe('regular');
  });

  it('15:40–16:00(시간외 종가매매)은 정규장으로 남는다', () => {
    // 그 구간엔 사다리라는 개념이 없어 기본값으로 삼으면 빈 화면이 기본이 된다.
    expect(defaultBookSessionMode(kst(DAY, 15, 45))).toBe('regular');
  });
});

describe('bookSessionEpoch — 오버라이드 만료의 파생', () => {
  it('16:00 을 넘으면 epoch 가 바뀐다', () => {
    expect(bookSessionEpoch(kst(DAY, 15, 59))).not.toBe(bookSessionEpoch(kst(DAY, 16, 1)));
  });

  it('같은 기본 모드라도 날짜가 다르면 다른 epoch', () => {
    // 자정 복귀만으로는 부족하다 — 어제 오전에 누른 오버라이드가 오늘 오전까지
    // 살아 있으면 안 된다.
    expect(bookSessionEpoch(kst(DAY, 10, 0))).not.toBe(bookSessionEpoch(kst(NEXT_DAY, 10, 0)));
  });

  it('같은 날 같은 국면 안에서는 안정적', () => {
    expect(bookSessionEpoch(kst(DAY, 16, 5))).toBe(bookSessionEpoch(kst(DAY, 17, 55)));
  });
});

describe('resolveBookSessionMode', () => {
  it('오버라이드가 없으면 시계 기본값', () => {
    expect(resolveBookSessionMode(null, kst(DAY, 16, 30))).toBe('afterHours');
  });

  it('같은 epoch 의 오버라이드는 기본값을 이긴다', () => {
    const at = kst(DAY, 16, 30);
    const override = { mode: 'regular' as const, epoch: bookSessionEpoch(at) };
    expect(resolveBookSessionMode(override, at)).toBe('regular');
  });

  it('경계를 넘으면 오버라이드가 만료된다', () => {
    // 15:00 에 "시간외" 를 눌러 둔 채 16:00 을 넘긴 경우. 16:00 부터는 시계
    // 기본값이 이미 시간외라 오버라이드가 남아 있을 이유가 없다.
    const pressedAt = kst(DAY, 15, 0);
    const override = { mode: 'afterHours' as const, epoch: bookSessionEpoch(pressedAt) };
    expect(resolveBookSessionMode(override, kst(DAY, 16, 1))).toBe('afterHours');
    // 그리고 다음날 오전에는 기본값(정규장)으로 돌아온다 — 만료가 실제로 걸린다.
    expect(resolveBookSessionMode(override, kst(NEXT_DAY, 10, 0))).toBe('regular');
  });

  it('16:30 에 정규장을 누르면 18:00 을 넘어도 유지된다', () => {
    // 18:00 은 기본값이 바뀌는 경계가 아니다(16:00–24:00 이 한 구간).
    const at = kst(DAY, 16, 30);
    const override = { mode: 'regular' as const, epoch: bookSessionEpoch(at) };
    expect(resolveBookSessionMode(override, kst(DAY, 19, 0))).toBe('regular');
  });
});

describe('krxAfterHoursLabel — 빈 5행을 설명하는 하중', () => {
  it('16:00 전에는 그냥 시간외', () => {
    expect(krxAfterHoursLabel(kst(DAY, 15, 45))).toBe('시간외');
  });

  it('16:00–18:00 은 시간외 단일가 — 5단 상한을 말하는 문안', () => {
    expect(krxAfterHoursLabel(kst(DAY, 16, 0))).toBe('시간외 단일가');
    expect(krxAfterHoursLabel(kst(DAY, 17, 59))).toBe('시간외 단일가');
  });

  it('18:00 정각에 문안이 풀린다 — 그 뒤 사다리는 벤더 실시간이 아니다', () => {
    expect(krxAfterHoursLabel(kst(DAY, 18, 0))).toBe('시간외');
  });

  it('저장본이면 **몇 시 값인지** 말한다', () => {
    // "마지막" 만으로는 부족하다 — 저장은 프론트가 마지막으로 본 순간에 일어나므로
    // 17:02 에 창을 닫았으면 저장본도 17:02 것이지 18:00 직전이 아니다.
    expect(krxAfterHoursLabel(kst(DAY, 21, 0), { storedAtMs: kst(DAY, 17, 2) })).toBe(
      '시간외 · 17:02',
    );
    // 창 안이어도 저장본이면 같다(판정은 storedAtMs 우선).
    expect(krxAfterHoursLabel(kst(DAY, 16, 30), { storedAtMs: kst(DAY, 16, 5) })).toBe(
      '시간외 · 16:05',
    );
  });

  it('저장본이 아니면 시각을 달지 않는다', () => {
    expect(krxAfterHoursLabel(kst(DAY, 21, 0), { storedAtMs: null })).toBe('시간외');
  });
});

describe('nxtPhaseLabel', () => {
  it.each([
    [8, 0, '프리마켓'],
    [8, 55, '프리마켓'], // KRX 시가단일가 중 NXT 정지 — 직전 국면 잔상이 화면에 있다
    [9, 0, '정규장'],
    [15, 25, '정규장'], // KRX 종가단일가 중 NXT 정지 — 같은 이유
    [15, 30, '애프터마켓'],
    [19, 59, '애프터마켓'],
    [20, 0, '애프터마켓 · 마지막'],
    [7, 0, '애프터마켓 · 마지막'], // 개장 전 새벽 — 화면엔 전일 마지막이 떠 있다
  ])('%s:%s → %s', (hh, mm, expected) => {
    expect(nxtPhaseLabel(kst(DAY, hh, mm))).toBe(expected);
  });
});

describe('bookSessionControl — 갈래 판정', () => {
  const base = { venue: 'KRX' as const, isSpot: false };

  it('nxt_enabled=false 는 토글', () => {
    const c = bookSessionControl({ ...base, nxtEnabled: false, nowMs: kst(DAY, 10, 0) });
    expect(c).toEqual({ kind: 'toggle', regularLabel: '정규장', afterHoursLabel: '시간외' });
  });

  it('nxt_enabled=false 는 16:00–18:00 에 단일가 문안을 단다', () => {
    const c = bookSessionControl({ ...base, nxtEnabled: false, nowMs: kst(DAY, 16, 30) });
    expect(c).toMatchObject({ kind: 'toggle', afterHoursLabel: '시간외 단일가' });
  });

  it('nxt_enabled=true + NXT venue 는 국면 라벨', () => {
    const c = bookSessionControl({
      ...base, nxtEnabled: true, venue: 'NXT', nowMs: kst(DAY, 16, 0),
    });
    expect(c).toEqual({ kind: 'label', label: '애프터마켓' });
  });

  it('nxt_enabled=true + 통합(UN) 도 국면 라벨', () => {
    const c = bookSessionControl({
      ...base, nxtEnabled: true, venue: 'UN', nowMs: kst(DAY, 16, 0),
    });
    expect(c).toEqual({ kind: 'label', label: '애프터마켓' });
  });

  it('⚠ NXT 종목이라도 KRX 를 고르면 애프터마켓이라 말하지 않는다', () => {
    // 화면엔 KRX 15:30 정지본이 떠 있다 — 그 프레임만 게이트를 통과하기 때문.
    const c = bookSessionControl({
      ...base, nxtEnabled: true, venue: 'KRX', nowMs: kst(DAY, 16, 0),
    });
    expect(c).toEqual({ kind: 'label', label: '정규장 · 마지막' });
  });

  it('KRX 를 고른 NXT 종목도 장중에는 그냥 정규장', () => {
    const c = bookSessionControl({
      ...base, nxtEnabled: true, venue: 'KRX', nowMs: kst(DAY, 11, 0),
    });
    expect(c).toEqual({ kind: 'label', label: '정규장' });
  });

  it('저장본을 그리는 중이면 토글 라벨이 그 시각을 단다', () => {
    const c = bookSessionControl({
      ...base, nxtEnabled: false, afterHoursStoredAtMs: kst(DAY, 17, 2), nowMs: kst(DAY, 21, 0),
    });
    expect(c).toMatchObject({ kind: 'toggle', afterHoursLabel: '시간외 · 17:02' });
  });

  it.each([[null], [undefined]])('nxt_enabled=%s(모름)이면 아무것도 그리지 않는다', (v) => {
    const c = bookSessionControl({ ...base, nxtEnabled: v, nowMs: kst(DAY, 16, 30) });
    expect(c).toEqual({ kind: 'none' });
  });

  it('스팟 커서 중에는 갈래와 무관하게 숨긴다', () => {
    const c = bookSessionControl({
      ...base, nxtEnabled: false, isSpot: true, nowMs: kst(DAY, 16, 30),
    });
    expect(c).toEqual({ kind: 'none' });
  });
});

describe('otherBookSessionMode', () => {
  it('두 모드를 뒤집는다', () => {
    expect(otherBookSessionMode('regular')).toBe('afterHours');
    expect(otherBookSessionMode('afterHours')).toBe('regular');
  });
});

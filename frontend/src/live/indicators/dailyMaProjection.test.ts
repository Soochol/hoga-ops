import { describe, it, expect } from 'vitest';
import {
  DAILY_MA_TRADING_TO_CALENDAR,
  DAILY_MA_FLOOR_STEP_DAYS,
  dailyMaLookbackDays,
  dailyMaFloorLookbackDays,
  quantizeDailyMaFloorDate,
  maxEnabledPeriod,
  dailyMaFetchWindow,
  pickTodayLiveClose,
} from './dailyMaProjection';
import { computeDailyMaByDate } from '../../chart/projectors/dailyMovingAverage';
import { PAST_CANDLES_MAX_DAYS, subtractDaysKst, daysBetweenKst, earliestAllowedMinuteDate } from '../liveDateTime';
import type { LiveMAConfig } from '../../state/livePage';
import type { Candle } from '../../api/types';

const slot = (over: Partial<LiveMAConfig>): LiveMAConfig => ({
  id: 'x', enabled: true, period: 20, color: '#ffffff', lineWidth: 1, source: 'close', ...over,
});

describe('dailyMaLookbackDays', () => {
  it('uses the conservative 1.5 factor (named constant, not liveDateTime 1.4)', () => {
    expect(DAILY_MA_TRADING_TO_CALENDAR).toBe(1.5);
    expect(dailyMaLookbackDays(20)).toBe(PAST_CANDLES_MAX_DAYS + Math.ceil(20 * 1.5) + 15);
  });

  it('covers the realistic KRX calendar span even at MA_PERIOD_MAX=400 (regression: period>190 under-coverage)', () => {
    // Realistic KRX density ≈ 1.48 calendar days per trading day. The lookback
    // window must cover at least that many calendar days beyond the minute pan
    // clamp, or the leftmost daily-MA points go null. A 1.4 factor failed here.
    const realisticCalendarFor400 = Math.ceil(400 * 1.48);
    expect(dailyMaLookbackDays(400)).toBeGreaterThanOrEqual(PAST_CANDLES_MAX_DAYS + realisticCalendarFor400);
  });
});

describe('maxEnabledPeriod', () => {
  it('returns the max enabled period, ignoring disabled slots', () => {
    expect(maxEnabledPeriod([
      slot({ period: 20 }),
      slot({ period: 120, enabled: false }),
      slot({ period: 60 }),
    ])).toBe(60);
  });

  it('defaults to 20 for empty / all-disabled', () => {
    expect(maxEnabledPeriod([])).toBe(20);
    expect(maxEnabledPeriod([slot({ period: 200, enabled: false })])).toBe(20);
  });
});

describe('dailyMaFetchWindow', () => {
  it('to = todayKst, from = today − lookback(maxEnabledPeriod)', () => {
    const todayKst = '20260612';
    const w = dailyMaFetchWindow(todayKst, [slot({ period: 20 }), slot({ period: 60 })]);
    expect(w.to).toBe(todayKst);
    expect(w.from).toBe(subtractDaysKst(todayKst, dailyMaLookbackDays(60)));
  });

  // ── displayFloorDate: 디스크 모드(hogaplay · 저장뷰 얼림 · 전역 우회)에서 250일 벽이
  //    사라져 화면이 기본 창보다 과거로 가는 축. #1424 후속(2026-08-24).
  const TODAY = '20260824';
  const CONFIGS = [slot({ period: 20 })];

  it('벤더 모드 하한(오늘−249)을 넘겨도 창이 움직이지 않는다 — 모드 플래그가 필요 없는 근거', () => {
    // 이 단언이 깨지면 벤더 모드에서도 좌측 팬마다 일봉 쿼리 키가 갈린다(ADR-0073 위반).
    const base = dailyMaFetchWindow(TODAY, CONFIGS);
    expect(dailyMaFetchWindow(TODAY, CONFIGS, earliestAllowedMinuteDate(TODAY))).toEqual(base);
    expect(dailyMaFetchWindow(TODAY, CONFIGS, subtractDaysKst(TODAY, 200))).toEqual(base);
  });

  it('하한이 기본 창보다 과거면 넓어진다 — 그것이 hogaplay 모드에서 비던 구간', () => {
    const floor = subtractDaysKst(TODAY, 600);
    const widened = dailyMaFetchWindow(TODAY, CONFIGS, floor);
    expect(widened.from < dailyMaFetchWindow(TODAY, CONFIGS).from).toBe(true);
    expect(widened.from < floor).toBe(true);
    expect(widened.to).toBe(TODAY);
  });

  it('넓힌 창은 하한에서 **이미 warmup이 끝나** 있다 — 하한에 딱 맞추면 구멍이 왼쪽으로 옮겨갈 뿐', () => {
    // 판별식: from~floor 사이 캘린더일이 period 거래일의 현실 밀도(≈1.48)를 덮는가.
    // `dailyMaFloorLookbackDays` 에서 warmup 항을 빼면 이 값이 0이 되어 즉시 빨개진다.
    for (const period of [20, 60, 120, 240]) {
      const floor = subtractDaysKst(TODAY, 600);
      const w = dailyMaFetchWindow(TODAY, [slot({ period })], floor);
      expect(daysBetweenKst(w.from, floor)).toBeGreaterThanOrEqual(Math.ceil(period * 1.48));
    }
  });

  it('하한이 하루씩 물러나도 창은 계단당 한 번만 바뀐다 — 팬 스텝마다 재fetch하지 않는 이유', () => {
    // 경계 위치에 기대지 않는 판별식: 201일치 하한이 만들어내는 **서로 다른 창의 수**를 센다.
    // 계단이 없으면 201개(하한마다 새 쿼리 키 = 새 fetch), 있으면 ⌈201/90⌉+1 이하.
    // 소비처가 실제로 쓰는 조합(quantize → fetchWindow)을 그대로 재현한다.
    const distinct = new Set<string>();
    for (let back = 500; back <= 700; back += 1) {
      const floor = quantizeDailyMaFloorDate(TODAY, subtractDaysKst(TODAY, back));
      distinct.add(dailyMaFetchWindow(TODAY, CONFIGS, floor).from);
    }
    expect(distinct.size).toBeLessThanOrEqual(Math.ceil(201 / DAILY_MA_FLOOR_STEP_DAYS) + 1);
    expect(distinct.size).toBeGreaterThan(1); // 계단을 넘으면 실제로 넓어진다(고정 창이 아니다)
  });

  it('미래·동일 날짜 하한은 기본 창을 그대로 둔다(음수 span 방어)', () => {
    const base = dailyMaFetchWindow(TODAY, CONFIGS);
    expect(dailyMaFetchWindow(TODAY, CONFIGS, TODAY)).toEqual(base);
    expect(dailyMaFetchWindow(TODAY, CONFIGS, '20270101')).toEqual(base);
  });

  it('실제 SMA로 확인 — 넓힌 창의 하한 거래일에 MA 값이 존재한다', () => {
    // 평일 일봉 픽스처를 창 전체에 깔고, 하한 날짜에 값이 나오는지 본다.
    // (기존 버그의 증상: 하한 근처가 통째로 undefined → 선이 안 그려짐)
    const period = 60;
    const floor = subtractDaysKst(TODAY, 500);
    const w = dailyMaFetchWindow(TODAY, [slot({ period })], floor);
    const candles: Array<{ t_ms: number; open: number; high: number; low: number; close: number; volume: number }> = [];
    for (let d = 0; d <= daysBetweenKst(w.from, TODAY); d += 1) {
      const ms = Date.UTC(
        parseInt(w.from.slice(0, 4), 10),
        parseInt(w.from.slice(4, 6), 10) - 1,
        parseInt(w.from.slice(6, 8), 10) + d,
      );
      const dow = new Date(ms).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      // 09:00 KST 앵커(일봉 t_ms 계약) = 00:00 UTC.
      candles.push({ t_ms: ms, open: 1000, high: 1000, low: 1000, close: 1000 + d, volume: 1 });
    }
    const byDate = computeDailyMaByDate(candles, period, 'close', TODAY, null);
    // floor 가 주말이면 픽스처에 그 날이 없다 — 가장 가까운 앞선 평일로 물러난다.
    // (상수가 바뀌어 floor 의 요일이 달라져도 결정적으로 남는다.)
    let probe = floor;
    for (let i = 0; i < 5 && !byDate.has(probe); i += 1) probe = subtractDaysKst(probe, 1);
    expect(byDate.get(probe)).toBeDefined();
  });
});

describe('quantizeDailyMaFloorDate', () => {
  it('계단 배수로만 내려간다 — 그 사이 하한은 같은 날짜로 접힌다', () => {
    const a = quantizeDailyMaFloorDate('20260824', subtractDaysKst('20260824', 500));
    const b = quantizeDailyMaFloorDate('20260824', subtractDaysKst('20260824', 501));
    const far = quantizeDailyMaFloorDate('20260824', subtractDaysKst('20260824', 500 + DAILY_MA_FLOOR_STEP_DAYS));
    expect(a).toBe(b);
    expect(far < a).toBe(true);
    expect(daysBetweenKst(a, '20260824') % DAILY_MA_FLOOR_STEP_DAYS).toBe(0);
  });

  it('내린 날짜는 원래 하한보다 과거다 — 덜 덮는 방향으로는 절대 안 움직인다', () => {
    for (const back of [1, 89, 90, 91, 300, 1000]) {
      const raw = subtractDaysKst('20260824', back);
      expect(quantizeDailyMaFloorDate('20260824', raw) <= raw).toBe(true);
    }
  });

  it('오늘 이후 하한은 오늘로 접는다(음수 span 방어)', () => {
    expect(quantizeDailyMaFloorDate('20260824', '20260824')).toBe('20260824');
    expect(quantizeDailyMaFloorDate('20260824', '20270101')).toBe('20260824');
  });
});

describe('dailyMaFloorLookbackDays', () => {
  it('하한을 덮되 warmup 몫을 얹는다', () => {
    const days = dailyMaFloorLookbackDays('20260824', subtractDaysKst('20260824', 400), 20);
    expect(days).toBeGreaterThanOrEqual(400 + Math.ceil(20 * DAILY_MA_TRADING_TO_CALENDAR) + 15);
  });

  it('하한이 기본선 안이면 기본선 그대로 — 반환값은 절대 기본선보다 작지 않다', () => {
    for (const back of [0, 100, 249, 250]) {
      expect(dailyMaFloorLookbackDays('20260824', subtractDaysKst('20260824', back), 20))
        .toBe(dailyMaLookbackDays(20));
    }
  });
});

describe('pickTodayLiveClose', () => {
  const D_0612 = 1781222400000; // 2026-06-12 09:00 KST
  const candle = (over: Partial<Candle>): Candle => ({
    ts_ms: D_0612, open: 1, close: 1, high: 1, low: 1, vol_a: 0, vol_b: 0, ...over,
  });

  it('returns last candle close when its trading-day === todayKst', () => {
    expect(pickTodayLiveClose([candle({ close: 1 }), candle({ ts_ms: D_0612 + 60_000, close: 200 })], '20260612')).toBe(200);
  });

  it('returns null when last candle is not today (weekend / pre-open)', () => {
    expect(pickTodayLiveClose([candle({ close: 200 })], '20260613')).toBeNull();
  });

  it('returns null for empty candles', () => {
    expect(pickTodayLiveClose([], '20260612')).toBeNull();
  });
});

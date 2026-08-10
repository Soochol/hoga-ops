import { describe, expect, it } from 'vitest';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';
import {
  formatKstHhmm,
  formatKstMmdd,
  indexCandlesByKstDate,
  resolveSyncTarget,
  type SyncCandle,
} from './studyCursorSync';

/** 2025-06-19 09:00 KST = 일봉 캔들의 ts_ms(장 시작 기준). */
const DAY_20250619 = Date.UTC(2025, 5, 19, 0, 0);
/** 같은 날 15:00 KST — 분봉 커서가 가리키는 시각. */
const CURSOR_1500 = Date.UTC(2025, 5, 19, 6, 0);
/** 그 다음 거래일. */
const DAY_20250620 = Date.UTC(2025, 5, 20, 0, 0);

const CANDLES: SyncCandle[] = [
  { ts_ms: DAY_20250619, close: 212000 },
  { ts_ms: DAY_20250620, close: 220500 },
];

function origin(over: Partial<SidebarCursorOrigin> = {}): SidebarCursorOrigin {
  return { windowId: 'minute-window', group: null, code: '064350', timeframe: '3m', ...over };
}

function target(over: Partial<SidebarCursorOrigin> = {}, tsMs = CURSOR_1500) {
  return resolveSyncTarget({
    cursor: { tsMs, origin: origin(over) },
    myWindowId: 'daily-window',
    myCode: '064350',
    byDate: indexCandlesByKstDate(CANDLES),
  });
}

describe('indexCandlesByKstDate', () => {
  it('KST 날짜를 키로 쓴다 — UTC 로 나누면 자정~09시 봉이 전날로 밀린다', () => {
    const byDate = indexCandlesByKstDate(CANDLES);
    expect([...byDate.keys()]).toEqual(['20250619', '20250620']);
  });
});

describe('resolveSyncTarget', () => {
  it('분봉 커서의 시각을 같은 KST 날짜의 일봉 캔들로 스냅한다', () => {
    // 15:00 커서가 09:00 앵커의 일봉으로 접힌다 — 시각이 아니라 **날짜**가 다리다.
    expect(target()).toEqual({ ts_ms: DAY_20250619, close: 212000 });
  });

  it('발행이 없으면 대상이 없다', () => {
    expect(resolveSyncTarget({
      cursor: null, myWindowId: 'daily-window', myCode: '064350',
      byDate: indexCandlesByKstDate(CANDLES),
    })).toBeNull();
  });

  it('내가 발행자면 무시한다 — 자기 호버를 되받으면 lwc 크로스헤어와 이중이 된다', () => {
    expect(target({ windowId: 'daily-window' })).toBeNull();
  });

  it('일봉 발행은 무시한다 — 같은 축이면 동기화할 것이 없다', () => {
    expect(target({ timeframe: 'D' })).toBeNull();
  });

  it('종목이 다르면 무시한다', () => {
    expect(target({ code: '005930' })).toBeNull();
  });

  it('origin 이나 내 code 가 미상이면 종목 검사를 건너뛴다', () => {
    // 한쪽이 null 인 상태로 막아 버리면 code 가 아직 안 붙은 창에서 기능이 통째로
    // 죽는다. 불일치가 **확인된** 경우에만 거른다.
    expect(target({ code: null })).not.toBeNull();
    expect(resolveSyncTarget({
      cursor: { tsMs: CURSOR_1500, origin: origin() },
      myWindowId: 'daily-window', myCode: null,
      byDate: indexCandlesByKstDate(CANDLES),
    })).not.toBeNull();
  });

  it('그 날의 일봉이 이 창에 없으면 대상이 없다 — 맥락 창 밖·휴장', () => {
    const holiday = Date.UTC(2025, 5, 21, 6, 0); // 토요일
    expect(target({}, holiday)).toBeNull();
  });
});

describe('라벨 포맷', () => {
  it('KST 로 변환해 시:분을 만든다 — UTC 그대로면 9시간 어긋난다', () => {
    expect(formatKstHhmm(CURSOR_1500)).toBe('15:00');
  });

  it('엣지 인디케이터는 날짜까지 보여 준다', () => {
    expect(formatKstMmdd(CURSOR_1500)).toBe('06/19');
  });

  it('자정 직전 KST 는 UTC 기준으로 다음 날이지만 KST 날짜를 유지한다', () => {
    const lateNight = Date.UTC(2025, 5, 19, 14, 30); // KST 23:30
    expect(formatKstHhmm(lateNight)).toBe('23:30');
    expect(formatKstMmdd(lateNight)).toBe('06/19');
  });
});

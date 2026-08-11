import { describe, expect, it } from 'vitest';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';
import {
  formatKstMmdd,
  indexCandlesByKstDate,
  resolveSyncTarget,
  type SyncCandle,
} from './cursorSync';

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

/**
 * `/live` 워크스페이스에서 처음 의미를 갖는 성질들. `/study` 는 창이 전부 같은 종목·
 * 그룹 없음이라 이 축들이 상수였다.
 *
 * **이 가드가 막는 방향**: 종목이 다른 창끼리 동기화되는 것. **못 보는 것**: 양쪽
 * code 가 둘 다 null 인 경우(아래 마지막 케이스가 그 통과를 명시로 고정한다).
 */
describe('resolveSyncTarget — /live 스코프', () => {
  it('링크 그룹이 달라도 같은 종목이면 동기화한다 — 범위는 종목이다', () => {
    // 사용자 결정 2026-08-11. ADR-0119 §4 가 드로잉을 종목 귀속으로 뒤집은 것과 같은
    // 답이다. 그룹으로 좁히려면 여기가 실패해야 하므로, 이 단언이 곧 그 결정이다.
    expect(target({ group: 3 })).toEqual({ ts_ms: DAY_20250619, close: 212000 });
  });

  it('같은 그룹이라도 종목이 다르면 무시한다 — 그룹은 판정에 쓰이지 않는다', () => {
    expect(target({ group: 1, code: '005930' })).toBeNull();
  });

  it('지수 창은 code 가 `index:` 접두로 채워져 서로 갈린다', () => {
    // `/live` 지수 창의 code 는 `workareaCode` 가 `index:KOSPI` 로 만든다 — null 이
    // 아니므로 KOSPI 호버가 KOSDAQ 창으로 새지 않는다.
    expect(resolveSyncTarget({
      cursor: { tsMs: CURSOR_1500, origin: origin({ code: 'index:KOSPI' }) },
      myWindowId: 'daily-window', myCode: 'index:KOSDAQ',
      byDate: indexCandlesByKstDate(CANDLES),
    })).toBeNull();
  });

  it('⚠ 양쪽 code 가 둘 다 null 이면 통과한다 — 이 가드가 못 보는 구멍', () => {
    // 관대한 `!== null` 가드의 귀결이다. 현재 `/live` 도달 경로는 없지만(지수는
    // `index:` 로 채워지고, 종목 없는 창은 LiveChartRoot 를 렌더하지 않는다) code 가
    // null 인 창 종류가 새로 생기면 여기가 먼저 샌다. 통과를 명시로 남겨 둔다.
    expect(resolveSyncTarget({
      cursor: { tsMs: CURSOR_1500, origin: origin({ code: null }) },
      myWindowId: 'daily-window', myCode: null,
      byDate: indexCandlesByKstDate(CANDLES),
    })).not.toBeNull();
  });
});

describe('라벨 포맷', () => {
  it('엣지 인디케이터는 날짜만 보여 준다 — 분봉의 시:분은 일봉 창에 띄우지 않는다', () => {
    expect(formatKstMmdd(CURSOR_1500)).toBe('06/19');
  });

  it('자정 직전 KST 는 UTC 기준으로 다음 날이지만 KST 날짜를 유지한다', () => {
    // KST 23:30 — UTC 로는 이미 06/19 14:30 이라 그대로 쓰면 날짜가 맞고,
    // 09:00 이후 KST 밤 시간대에서 어긋나는 것은 반대 방향이다.
    expect(formatKstMmdd(Date.UTC(2025, 5, 19, 14, 30))).toBe('06/19');
    // KST 00:30(06/20) — UTC 로는 아직 06/19 15:30 이다. 여기서 갈린다.
    expect(formatKstMmdd(Date.UTC(2025, 5, 19, 15, 30))).toBe('06/20');
  });
});

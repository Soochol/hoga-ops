import { describe, expect, it } from 'vitest';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';
import {
  canPublishSyncCursor,
  formatKstMmdd,
  indexCandlesByKstDate,
  isSyncConsumerTimeframe,
  resolveSyncTarget,
  snapToInstant,
  snapToLastOfKstDay,
  type SyncCandle,
  type SyncResolution,
} from './cursorSync';

/** 판정 결과에서 **대상 캔들만** 꺼낸다 — `hit` 이 아니면 null.
 *  기존 단언 문체(캔들 또는 null)를 그대로 쓰되, `out-of-range` 는 별도 블록이 잰다. */
function hitOf(r: SyncResolution): SyncCandle | null {
  return r.kind === 'hit' ? r.candle : null;
}

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

/** 분봉 소비 창의 캔들 — 06/19 는 5분봉 세 개뿐이고 **06/20 은 없다**(로드 범위 밖).
 *  일부러 성기게 두어 "가장 가까운 봉" 선택과 날짜 가드가 각각 눈에 보이게 한다. */
const M_1450 = Date.UTC(2025, 5, 19, 5, 50); // 14:50 KST
const M_1455 = Date.UTC(2025, 5, 19, 5, 55); // 14:55
const M_1500 = Date.UTC(2025, 5, 19, 6, 0); // 15:00 — CURSOR_1500 과 같은 순간
const MINUTE_CANDLES: SyncCandle[] = [
  { ts_ms: M_1450, close: 211000 },
  { ts_ms: M_1455, close: 211500 },
  { ts_ms: M_1500, close: 212000 },
];

function origin(over: Partial<SidebarCursorOrigin> = {}): SidebarCursorOrigin {
  return { windowId: 'minute-window', group: null, code: '064350', timeframe: '3m', ...over };
}

/** 종목 게이트가 **켜진**(= 같은 종목만) 모드. 2026-08-11~08-21 의 유일한 동작. */
function target(over: Partial<SidebarCursorOrigin> = {}, tsMs = CURSOR_1500) {
  return hitOf(resolveSyncTarget({
    cursor: { tsMs, origin: origin(over) },
    myWindowId: 'daily-window',
    myCode: '064350',
    source: { axis: 'date', byDate: indexCandlesByKstDate(CANDLES), candles: CANDLES },
    allowCrossSymbol: false,
  }));
}

/** 분봉 소비 창(= `instant` 다리). 종목 게이트는 끈 상태로 둔다 — 이 블록이 재는 건
 *  다리와 발행 봉 집합이지 종목 축이 아니다(종목 축은 위 블록들이 이미 고정한다). */
function minuteTarget(
  over: Partial<SidebarCursorOrigin> = {},
  tsMs = CURSOR_1500,
  candles: readonly SyncCandle[] = MINUTE_CANDLES,
) {
  return hitOf(resolveSyncTarget({
    cursor: { tsMs, origin: origin(over) },
    myWindowId: 'minute-consumer',
    myCode: '064350',
    source: { axis: 'instant', candles },
    allowCrossSymbol: true,
  }));
}

/** 분봉 소비 창의 **판정 전체**(세 갈래). `minuteTarget` 은 그중 `hit` 만 본다. */
function minuteResolution(
  over: Partial<SidebarCursorOrigin> = {},
  tsMs = CURSOR_1500,
  candles: readonly SyncCandle[] = MINUTE_CANDLES,
): SyncResolution {
  return resolveSyncTarget({
    cursor: { tsMs, origin: origin(over) },
    myWindowId: 'minute-consumer',
    myCode: '064350',
    source: { axis: 'instant', candles },
    allowCrossSymbol: true,
  });
}

/** 종목 게이트를 **끈** 모드(`cursorSyncCrossSymbol` 켬 — 레지스트리 기본값). */
function targetCross(over: Partial<SidebarCursorOrigin> = {}, tsMs = CURSOR_1500) {
  return hitOf(resolveSyncTarget({
    cursor: { tsMs, origin: origin(over) },
    myWindowId: 'daily-window',
    myCode: '064350',
    source: { axis: 'date', byDate: indexCandlesByKstDate(CANDLES), candles: CANDLES },
    allowCrossSymbol: true,
  }));
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
    expect(hitOf(resolveSyncTarget({
      cursor: null, myWindowId: 'daily-window', myCode: '064350',
      source: { axis: 'date', byDate: indexCandlesByKstDate(CANDLES), candles: CANDLES }, allowCrossSymbol: false,
    }))).toBeNull();
  });

  it('내가 발행자면 무시한다 — 자기 호버를 되받으면 lwc 크로스헤어와 이중이 된다', () => {
    expect(target({ windowId: 'daily-window' })).toBeNull();
  });

  it('W/M 발행은 무시한다 — 한 캔들이 여러 날이라 스냅할 다리가 없다', () => {
    // 원래 여기 「일봉 발행은 무시한다 — 같은 축이면 동기화할 것이 없다」가 있었다.
    // 2026-08-21 에 **뒤집혔다**: 창마다 뷰포트가 독립이라 "같은 축이면 같은 칸" 이
    // 애초에 참이 아니었다(일봉→일봉은 아래 전용 describe 가 고정한다). 남은 것은
    // 정말로 다리가 없는 W/M 뿐이다.
    expect(target({ timeframe: 'W' })).toBeNull();
    expect(target({ timeframe: 'M' })).toBeNull();
  });

  it('종목이 다르면 무시한다 — `allowCrossSymbol` 이 꺼진 모드', () => {
    expect(target({ code: '005930' })).toBeNull();
  });

  it('origin 이나 내 code 가 미상이면 종목 검사를 건너뛴다', () => {
    // 한쪽이 null 인 상태로 막아 버리면 code 가 아직 안 붙은 창에서 기능이 통째로
    // 죽는다. 불일치가 **확인된** 경우에만 거른다.
    expect(target({ code: null })).not.toBeNull();
    expect(resolveSyncTarget({
      cursor: { tsMs: CURSOR_1500, origin: origin() },
      myWindowId: 'daily-window', myCode: null,
      source: { axis: 'date', byDate: indexCandlesByKstDate(CANDLES), candles: CANDLES }, allowCrossSymbol: false,
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
 * **이 가드가 막는 방향**: `allowCrossSymbol` 이 **꺼진 모드**에서 종목이 다른 창끼리
 * 동기화되는 것. 켠 모드는 아래 별도 describe 가 잰다. **못 보는 것**: 양쪽 code 가
 * 둘 다 null 인 경우(아래 마지막 케이스가 그 통과를 명시로 고정한다).
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
    expect(hitOf(resolveSyncTarget({
      cursor: { tsMs: CURSOR_1500, origin: origin({ code: 'index:KOSPI' }) },
      myWindowId: 'daily-window', myCode: 'index:KOSDAQ',
      source: { axis: 'date', byDate: indexCandlesByKstDate(CANDLES), candles: CANDLES }, allowCrossSymbol: false,
    }))).toBeNull();
  });

  it('⚠ 양쪽 code 가 둘 다 null 이면 통과한다 — 이 가드가 못 보는 구멍', () => {
    // 관대한 `!== null` 가드의 귀결이다. 현재 `/live` 도달 경로는 없지만(지수는
    // `index:` 로 채워지고, 종목 없는 창은 LiveChartRoot 를 렌더하지 않는다) code 가
    // null 인 창 종류가 새로 생기면 여기가 먼저 샌다. 통과를 명시로 남겨 둔다.
    expect(resolveSyncTarget({
      cursor: { tsMs: CURSOR_1500, origin: origin({ code: null }) },
      myWindowId: 'daily-window', myCode: null,
      source: { axis: 'date', byDate: indexCandlesByKstDate(CANDLES), candles: CANDLES }, allowCrossSymbol: false,
    })).not.toBeNull();
  });
});

/**
 * `cursorSyncCrossSymbol` 이 **켜진** 모드(⚙️ 설정 → 차트, 레지스트리 기본값).
 *
 * **이 블록이 고정하는 것**: 게이트 4(종목)만 열리고 나머지 셋은 그대로라는 것.
 * "다른 종목에도 뜬다" 만 재면 자기 발행 되받기·일봉 발행까지 함께 열려도 초록이라,
 * 열린 축과 닫힌 축을 **같이** 잰다.
 */
describe('resolveSyncTarget — 다른 종목까지(cursorSyncCrossSymbol 켬)', () => {
  it('종목이 달라도 같은 날짜의 일봉 캔들을 가리킨다', () => {
    // 사용자 결정 2026-08-21. 게이트가 꺼진 모드에서는 이 입력이 null 이다
    // (위 「종목이 다르면 무시한다」와 같은 입력) — 두 단언이 곧 토글의 정의다.
    expect(targetCross({ code: '005930' })).toEqual({ ts_ms: DAY_20250619, close: 212000 });
  });

  it('지수 창도 개별 종목 호버를 받는다 — 다리가 날짜뿐이라 종목 종류를 가리지 않는다', () => {
    // `index:KOSPI` 일봉 창 ← 개별 종목 분봉 호버. 꺼진 모드에서는 갈렸다.
    expect(hitOf(resolveSyncTarget({
      cursor: { tsMs: CURSOR_1500, origin: origin({ code: '005930' }) },
      myWindowId: 'daily-window', myCode: 'index:KOSPI',
      source: { axis: 'date', byDate: indexCandlesByKstDate(CANDLES), candles: CANDLES }, allowCrossSymbol: true,
    }))).toEqual({ ts_ms: DAY_20250619, close: 212000 });
  });

  it('지수끼리도 서로 받는다 — KOSPI 호버 → KOSDAQ 창', () => {
    expect(hitOf(resolveSyncTarget({
      cursor: { tsMs: CURSOR_1500, origin: origin({ code: 'index:KOSPI' }) },
      myWindowId: 'daily-window', myCode: 'index:KOSDAQ',
      source: { axis: 'date', byDate: indexCandlesByKstDate(CANDLES), candles: CANDLES }, allowCrossSymbol: true,
    }))).toEqual({ ts_ms: DAY_20250619, close: 212000 });
  });

  it('내가 발행자면 여전히 무시한다 — 열린 건 종목 축뿐이다', () => {
    expect(targetCross({ windowId: 'daily-window', code: '005930' })).toBeNull();
  });

  it('W/M 발행은 여전히 무시한다 — 토글이 연 건 종목 축뿐이다', () => {
    expect(targetCross({ timeframe: 'W', code: '005930' })).toBeNull();
    expect(targetCross({ timeframe: 'M', code: '005930' })).toBeNull();
  });

  it('그 날의 일봉이 이 창에 없으면 여전히 대상이 없다 — 휴장', () => {
    const holiday = Date.UTC(2025, 5, 21, 6, 0); // 토요일
    expect(targetCross({ code: '005930' }, holiday)).toBeNull();
  });
});

/**
 * **일봉 → 일봉**(2026-08-21). `date` 소비자는 분봉뿐 아니라 `D` 발행도 받는다.
 *
 * 왜 의미가 있나: 옛 게이트는 "일봉↔일봉은 같은 축이면 그냥 같은 칸" 이라며 막았는데,
 * **창마다 뷰포트가 독립**이라 그 전제가 애초에 성립하지 않았다. 종목까지 다르면
 * 더더욱 아니다.
 *
 * **이 블록이 막는 방향**: `date` 소비자가 W/M 발행까지 받는 것(한 캔들이 여러 날).
 */
describe('resolveSyncTarget — 일봉 → 일봉', () => {
  it('일봉 발행을 받는다', () => {
    expect(target({ timeframe: 'D', windowId: 'other-daily' }))
      .toEqual({ ts_ms: DAY_20250619, close: 212000 });
  });

  it('종목이 달라도 받는다 — 종목 축은 토글이 정한다', () => {
    expect(targetCross({ timeframe: 'D', windowId: 'other-daily', code: '005930' }))
      .toEqual({ ts_ms: DAY_20250619, close: 212000 });
    // 끈 모드에서는 같은 입력이 막힌다 — 두 단언이 곧 토글의 정의다.
    expect(target({ timeframe: 'D', windowId: 'other-daily', code: '005930' })).toBeNull();
  });

  it('내가 발행자면 여전히 무시한다 — 일봉↔일봉에서 자기 되받기가 가장 흔하다', () => {
    // 소비 창과 **같은 windowId** 여야 게이트 2 가 걸린다. 이제 일봉도 발행자라
    // 자기 호버가 자기에게 돌아오는 경로가 실제로 생겼다(전에는 발행 자체가 없었다).
    expect(target({ timeframe: 'D', windowId: 'daily-window' })).toBeNull();
  });

  it('W/M 발행은 받지 않는다 — 한 캔들이 여러 날이라 다리가 없다', () => {
    expect(target({ timeframe: 'W', windowId: 'other' })).toBeNull();
    expect(target({ timeframe: 'M', windowId: 'other' })).toBeNull();
  });
});

/**
 * **분봉 → 분봉**(2026-08-21). `instant` 소비자는 같은 **순간**으로 스냅한다.
 *
 * **이 블록이 막는 방향**: ① 일봉 발행이 분봉 창에 새는 것(범위 밖 — 하루가 구간이라
 * 별도 설계가 필요하다) ② 그 날이 이 창에 없는데 며칠 떨어진 봉을 잡는 것.
 * **못 보는 것**: ②에서 아무것도 안 그리는 그 침묵을 화면에 설명하지는 못한다.
 */
describe('resolveSyncTarget — 분봉 → 분봉', () => {
  it('같은 순간의 봉을 가리킨다 — 날짜가 아니라 시각이 다리다', () => {
    expect(minuteTarget()).toEqual({ ts_ms: M_1500, close: 212000 });
  });

  it('정확히 일치하지 않으면 가장 가까운 봉으로 스냅한다', () => {
    // 14:56 → 14:55(1분) vs 15:00(4분) → 앞 봉.
    expect(minuteTarget({}, Date.UTC(2025, 5, 19, 5, 56))).toEqual({ ts_ms: M_1455, close: 211500 });
    // 14:59 → 15:00 이 더 가깝다.
    expect(minuteTarget({}, Date.UTC(2025, 5, 19, 5, 59))).toEqual({ ts_ms: M_1500, close: 212000 });
  });

  it('정확히 두 봉 사이면 앞 봉이 이긴다 — 봉 ts 는 버킷 시작이다', () => {
    // 14:52:30 은 14:50 과 14:55 의 정중앙.
    expect(minuteTarget({}, Date.UTC(2025, 5, 19, 5, 52, 30)))
      .toEqual({ ts_ms: M_1450, close: 211000 });
  });

  it('그 날이 이 창에 없으면 크로스헤어는 안 걸고 방향만 알려 준다', () => {
    // 06/20 커서인데 이 창은 06/19 만 들고 있다. 가장 가까운 봉은 06/19 15:00 이라
    // 그걸 그리면 거짓 표시가 된다 — 그래서 `hit` 이 아니다. 다만 2026-08-21 이전엔
    // 여기가 **침묵**이었고, 그 침묵이 "고장났다" 로 읽혔다. 이제 칩이 뜬다.
    expect(minuteTarget({}, Date.UTC(2025, 5, 20, 6, 0))).toBeNull();
    expect(minuteResolution({}, Date.UTC(2025, 5, 20, 6, 0)))
      .toEqual({ kind: 'out-of-range', side: 'right' });
  });

  it('캔들이 아직 없으면 대상이 없다', () => {
    expect(minuteTarget({}, CURSOR_1500, [])).toBeNull();
  });
});

/**
 * 다리 없이 `snapToInstant` 만 직접 재는 층 — 이진 탐색의 경계가 여기 고정된다.
 * 위 describe 는 게이트를 함께 통과해야 해서, 탐색 자체의 실수(off-by-one)를
 * 게이트 실패와 구별하지 못한다.
 */
describe('snapToInstant', () => {
  it('첫 봉보다 이른 커서도 같은 날이면 첫 봉을 준다', () => {
    expect(snapToInstant(MINUTE_CANDLES, Date.UTC(2025, 5, 19, 0, 30))) // 09:30 KST
      .toEqual({ ts_ms: M_1450, close: 211000 });
  });

  it('마지막 봉보다 늦은 커서도 같은 날이면 마지막 봉을 준다', () => {
    expect(snapToInstant(MINUTE_CANDLES, Date.UTC(2025, 5, 19, 6, 25))) // 15:25 KST
      .toEqual({ ts_ms: M_1500, close: 212000 });
  });

  it('날짜가 다르면 아무리 가까워도 버린다', () => {
    // KST 06/20 00:01 — 06/19 15:00 봉과 9시간여 차이지만 날짜가 갈린다.
    expect(snapToInstant(MINUTE_CANDLES, Date.UTC(2025, 5, 19, 15, 1))).toBeNull();
  });

  it('빈 배열은 null', () => {
    expect(snapToInstant([], CURSOR_1500)).toBeNull();
  });
});

/**
 * 발행 집합과 소비 집합은 **같아야 한다**.
 *
 * 갈라지면 2026-08-11 실측이 그대로 재현된다 — 아무도 받지 않는 발행이 전역 슬롯
 * 하나를 훔쳐 유효한 표시를 지운다. 그래서 이 단언은 스타일이 아니라 **불변식**이다.
 */
/**
 * **일봉 → 분봉**(2026-08-21). 마지막으로 열린 방향이고, 스냅 규칙이 **다른 셋과
 * 다르다** — 하루가 분봉 축에서 구간이라 "어디에 설지" 를 정해야 했다.
 *
 * **이 블록의 판별 단언**: 발행 ms 는 일봉 캔들 ts = 그 날 **09:00 앵커**다. 최근접
 * 스냅(`snapToInstant`)을 그대로 쓰면 그 날 **첫** 봉이 잡힌다. 사용자 선택은
 * **마지막 봉**이므로, 첫 봉 ≠ 마지막 봉인 픽스처에서 09:00 앵커 커서를 넣으면 두
 * 구현이 갈린다. 아래 첫 단언이 그 지점이다.
 */
describe('resolveSyncTarget — 일봉 → 분봉', () => {
  /** 06/19 일봉 캔들의 ts — 그 날 09:00 KST 앵커. */
  const DAILY_ANCHOR_20250619 = Date.UTC(2025, 5, 19, 0, 0);
  const dailyOrigin = { windowId: 'daily-window', timeframe: 'D' as const };

  it('그 날 **마지막** 봉에 선다 — 최근접 스냅이면 첫 봉(14:50)이 잡힌다', () => {
    // 09:00 앵커에서 가장 가까운 봉은 14:50 이다. 그런데 정답은 15:00 —
    // 첫 봉 자리에는 이미 「날짜 구분선」이 서 있어 두 선이 겹쳐 읽히지 않는다.
    expect(minuteTarget(dailyOrigin, DAILY_ANCHOR_20250619))
      .toEqual({ ts_ms: M_1500, close: 212000 });
  });

  it('그 날이 이 창에 없으면 방향을 알려 준다 — 일봉 창은 수개월, 분봉 창은 1~2일', () => {
    // 이 방향에서는 이게 예외가 아니라 **다수**다. 침묵하면 "고장났다" 로 읽힌다.
    const older = Date.UTC(2025, 5, 10, 0, 0); // 06/10 — 로드 범위보다 앞
    expect(minuteResolution(dailyOrigin, older))
      .toEqual({ kind: 'out-of-range', side: 'left' });
  });

  it('분봉 발행은 여전히 같은 순간으로 스냅한다 — 스냅은 발행 봉이 가른다', () => {
    // 같은 09:00 앵커 ms 라도 분봉 발행이면 최근접(14:50)이다. 이 단언과 위 첫
    // 단언이 **같은 입력·다른 발행 봉**이라, 둘이 갈리는 것 자체가 규칙의 정의다.
    expect(minuteTarget({}, DAILY_ANCHOR_20250619)).toEqual({ ts_ms: M_1450, close: 211000 });
  });

  it('내가 발행자면 무시한다 — 칩도 뜨지 않는다', () => {
    // ⚠ 게이트 차단이 `out-of-range` 로 새면 자기 호버마다 자기 창에 칩이 뜬다.
    expect(minuteResolution({ ...dailyOrigin, windowId: 'minute-consumer' }, DAILY_ANCHOR_20250619))
      .toEqual({ kind: 'none' });
  });

  it('W 발행은 무시한다 — 칩도 뜨지 않는다', () => {
    const far = Date.UTC(2025, 5, 10, 0, 0); // 범위 밖이지만 게이트가 먼저 걸린다
    expect(minuteResolution({ windowId: 'w-window', timeframe: 'W' }, far))
      .toEqual({ kind: 'none' });
  });
});

/**
 * `out-of-range` 는 **방향과 무관하게** 일괄 적용된다 — 일봉 소비자도 같은 대접을
 * 받는다(맥락 창 밖 날짜를 호버한 경우).
 *
 * **막는 방향**: 범위 **안**인데 캔들이 없는 날(휴장)까지 "범위 밖" 이라 말하는 것.
 * 그건 휴일마다 거짓말이 된다.
 */
describe('resolveSyncTarget — 로드 범위 밖 안내', () => {
  const resolution = (tsMs: number) => resolveSyncTarget({
    cursor: { tsMs, origin: origin({ windowId: 'other' }) },
    myWindowId: 'daily-window',
    myCode: '064350',
    source: { axis: 'date', byDate: indexCandlesByKstDate(CANDLES), candles: CANDLES },
    allowCrossSymbol: false,
  });

  it('로드 범위보다 앞이면 left', () => {
    expect(resolution(Date.UTC(2025, 5, 10, 6, 0))).toEqual({ kind: 'out-of-range', side: 'left' });
  });

  it('로드 범위보다 뒤면 right', () => {
    expect(resolution(Date.UTC(2025, 5, 25, 6, 0))).toEqual({ kind: 'out-of-range', side: 'right' });
  });

  it('범위 **안**인데 그 날이 없으면 none — 휴장에 "범위 밖" 은 거짓말이다', () => {
    // 06/19 와 06/20 사이는 없지만, 픽스처가 연속 이틀이라 그 사이 날짜가 없다.
    // 대신 범위 안 경계를 직접 만든다: 06/19~06/21 을 들고 06/20 만 비운 창.
    const holed = [CANDLES[0], { ts_ms: Date.UTC(2025, 5, 21, 0, 0), close: 1 }];
    expect(resolveSyncTarget({
      cursor: { tsMs: Date.UTC(2025, 5, 20, 6, 0), origin: origin({ windowId: 'other' }) },
      myWindowId: 'daily-window',
      myCode: '064350',
      source: { axis: 'date', byDate: indexCandlesByKstDate(holed), candles: holed },
      allowCrossSymbol: false,
    })).toEqual({ kind: 'none' });
  });

  it('캔들이 아직 없으면 none — 로딩 중 칩은 소음이다', () => {
    expect(resolveSyncTarget({
      cursor: { tsMs: CURSOR_1500, origin: origin({ windowId: 'other' }) },
      myWindowId: 'daily-window',
      myCode: '064350',
      source: { axis: 'date', byDate: new Map(), candles: [] },
      allowCrossSymbol: false,
    })).toEqual({ kind: 'none' });
  });

  it('종목 게이트에 걸리면 칩도 뜨지 않는다 — 게이트가 다리보다 먼저다', () => {
    expect(resolveSyncTarget({
      cursor: { tsMs: Date.UTC(2025, 5, 10, 6, 0), origin: origin({ windowId: 'other', code: '005930' }) },
      myWindowId: 'daily-window',
      myCode: '064350',
      source: { axis: 'date', byDate: indexCandlesByKstDate(CANDLES), candles: CANDLES },
      allowCrossSymbol: false,
    })).toEqual({ kind: 'none' });
  });
});

describe('snapToLastOfKstDay', () => {
  it('그 날의 마지막 봉을 준다 — 커서가 그 날 어디에 있든', () => {
    for (const ms of [Date.UTC(2025, 5, 19, 0, 0), Date.UTC(2025, 5, 19, 3, 0), M_1450]) {
      expect(snapToLastOfKstDay(MINUTE_CANDLES, ms)).toEqual({ ts_ms: M_1500, close: 212000 });
    }
  });

  it('그 날 봉이 하나도 없으면 null — 앞 날의 마지막 봉으로 새지 않는다', () => {
    expect(snapToLastOfKstDay(MINUTE_CANDLES, Date.UTC(2025, 5, 20, 3, 0))).toBeNull();
  });

  it('KST 자정 경계에서 날짜가 갈린다', () => {
    // UTC 06/19 15:00 = KST 06/20 00:00 → 06/19 의 마지막 봉이 아니다.
    expect(snapToLastOfKstDay(MINUTE_CANDLES, Date.UTC(2025, 5, 19, 15, 0))).toBeNull();
    // 그 1분 전은 아직 KST 06/19 다.
    expect(snapToLastOfKstDay(MINUTE_CANDLES, Date.UTC(2025, 5, 19, 14, 59)))
      .toEqual({ ts_ms: M_1500, close: 212000 });
  });

  it('빈 배열은 null', () => {
    expect(snapToLastOfKstDay([], CURSOR_1500)).toBeNull();
  });
});

describe('발행 ↔ 소비 집합', () => {
  it('분봉과 D 만 발행하고, 같은 집합만 소비한다', () => {
    for (const tf of ['1m', '5m', '60m', '240m', 'D'] as const) {
      expect(canPublishSyncCursor(tf)).toBe(true);
      expect(isSyncConsumerTimeframe(tf)).toBe(true);
    }
    for (const tf of ['W', 'M'] as const) {
      expect(canPublishSyncCursor(tf)).toBe(false);
      expect(isSyncConsumerTimeframe(tf)).toBe(false);
    }
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

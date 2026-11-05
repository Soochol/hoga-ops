import { calendarBucketKey } from '../live/aggregateCandles';
import { unixMsToKSTDate } from '../util/time';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';

/** 소비 창이 그리고 있는 캔들 중 동기화에 필요한 최소 필드. */
export type SyncCandle = {
  ts_ms: number;
  /** 크로스헤어 가로선 높이. 발행 창의 가격을 내 축에 옮기는 건 의미가 없어
   *  **내 캔들의** 종가를 쓴다(종목이 다르면 가격대 자체가 다르다). */
  close: number;
};

export type SyncCursor = {
  tsMs: number;
  origin: SidebarCursorOrigin;
};

export function isSyncConsumerTimeframe(tf: LiveTimeframe): boolean {
  return isMinuteTimeframe(tf) || tf === 'D' || tf === 'W' || tf === 'M';
}

export function canPublishSyncCursor(tf: LiveTimeframe): boolean {
  return isMinuteTimeframe(tf) || tf === 'D';
}

export type SyncTargetSource =
  | { axis: 'calendar'; granularity: 'D' | 'W' | 'M'; byBucket: ReadonlyMap<string, SyncCandle>; candles: readonly SyncCandle[] }
  | { axis: 'instant'; candles: readonly SyncCandle[] };

export function buildSyncTargetSource(candles: readonly SyncCandle[], timeframe: LiveTimeframe): SyncTargetSource {
  if (timeframe !== 'D' && timeframe !== 'W' && timeframe !== 'M') return { axis: 'instant', candles };
  const byBucket = new Map<string, SyncCandle>();
  for (const candle of candles) byBucket.set(calendarBucketKey(candle.ts_ms, timeframe), candle);
  return { axis: 'calendar', granularity: timeframe, byBucket, candles };
}

/**
 * 판정 결과 **세 갈래**. 불리언(대상 있음/없음)으로 두면 "게이트에 걸렸다" 와 "그 날이
 * 이 창에 없다" 가 화면에서 같은 침묵이 되는데, 둘은 사용자에게 전혀 다른 사실이다 —
 * 전자는 정상 동작이고 후자는 "여기선 못 보여 준다" 는 안내가 필요하다.
 */
export type SyncResolution =
  /** 아무것도 하지 않는다 — 게이트에 걸렸거나(발행 없음·자기 발행·안 받는 봉),
   *  로드 범위 **안**인데 그 날 캔들이 없다(휴장 등). 후자에 칩을 띄우면 휴일마다
   *  "범위 밖" 이라 거짓말을 하게 된다. */
  | { kind: 'none' }
  | { kind: 'hit'; candle: SyncCandle }
  /** 게이트는 통과했는데 그 날이 이 창의 로드 범위 **밖**이다. 방향만 알려 준다. */
  | { kind: 'out-of-range'; side: 'left' | 'right' };

/** `ms` 이상인 첫 캔들의 인덱스(없으면 `length`). 캔들이 ts 오름차순임에 기댄다. */
function lowerBound(candles: readonly SyncCandle[], ms: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts_ms < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `ms` 가 속한 KST 날짜가 **끝나는** 순간(다음 날 00:00 KST)의 Unix ms.
 *  날짜 문자열을 ms 로 되돌리는 역함수가 없어도 되도록 산술로 구한다. */
function kstDayEndMs(ms: number): number {
  return (Math.floor((ms + KST_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - KST_OFFSET_MS;
}

/**
 * 발행 ms 가 속한 KST 날짜의 **마지막 봉**.
 *
 * 일봉 발행을 분봉 축에 얹을 때 쓴다 — 발행 ms 는 그 날 09:00 앵커라 최근접 스냅을
 * 쓰면 **첫** 봉이 잡히는데, 거기엔 이미 날짜 구분선이 서 있어 겹쳐 읽히지 않는다
 * (사용자 결정 2026-08-21: 마지막 봉). 그 날 캔들이 하나도 없으면 `null`.
 */
export function snapToLastOfKstDay(
  candles: readonly SyncCandle[],
  cursorMs: number,
): SyncCandle | null {
  const i = lowerBound(candles, kstDayEndMs(cursorMs)) - 1;
  if (i < 0) return null;
  const c = candles[i];
  return unixMsToKSTDate(c.ts_ms) === unixMsToKSTDate(cursorMs) ? c : null;
}

/**
 * 그 날이 이 창의 로드 범위 **밖**인가 — 밖이면 어느 쪽인가.
 *
 * 범위 **안**인데 캔들이 없는 경우(휴장·구멍)는 `null` 이다. 거기에 "범위 밖" 칩을
 * 띄우면 휴일마다 거짓말을 하게 된다 — 그 날은 애초에 그릴 것이 없는 게 맞다.
 */
function outOfLoadedRange(
  candles: readonly SyncCandle[],
  cursorMs: number,
): 'left' | 'right' | null {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) return null; // 아직 로딩 중 — 칩은 소음이다.
  const date = unixMsToKSTDate(cursorMs);
  if (date < unixMsToKSTDate(first.ts_ms)) return 'left';
  if (date > unixMsToKSTDate(last.ts_ms)) return 'right';
  return null;
}

/**
 * 같은 순간으로 스냅 — 발행 ms 에 가장 가까운 내 봉.
 *
 * **인덱스를 만들지 않는다.** 분봉 번들은 틱마다 갱신되므로(실측 초당 ~8회) 날짜
 * 인덱스를 그때마다 재구축하면 캔들 수만큼의 일을 초당 여러 번 하게 된다. 캔들이
 * ts 오름차순이라 이진 탐색 O(log n) 으로 족하고, 이 함수는 커서가 바뀔 때만 돈다.
 *
 * **같은 KST 날짜가 아니면 버린다.** 그 날이 이 창에 없으면(옆 창만 과거로 팬)
 * 가장 가까운 봉이 며칠 떨어져 있을 수 있는데, 그리면 "동기화가 엉뚱한 데를
 * 가리킨다" 가 된다. 버린 뒤 그 사실이 화면에서 사라지지 않게 하는 것은 호출부의
 * 몫이다 — `resolveSyncTarget` 이 `out-of-range` 로 승격한다.
 *
 * 정확히 두 봉 사이면 **앞 봉**이 이긴다 — 커서가 버킷 경계에 있으면 그 시각을
 * 포함하는 쪽은 앞 봉이다(봉 ts 는 버킷 시작).
 */
export function snapToInstant(
  candles: readonly SyncCandle[],
  cursorMs: number,
): SyncCandle | null {
  if (candles.length === 0) return null;
  const i = lowerBound(candles, cursorMs);
  const after = i < candles.length ? candles[i] : null;
  const before = i > 0 ? candles[i - 1] : null;
  let nearest: SyncCandle | null;
  if (!before) nearest = after;
  else if (!after) nearest = before;
  else nearest = (after.ts_ms - cursorMs) < (cursorMs - before.ts_ms) ? after : before;
  if (!nearest) return null;
  return unixMsToKSTDate(nearest.ts_ms) === unixMsToKSTDate(cursorMs) ? nearest : null;
}

/**
 * 이 소비자가 저 발행 봉을 받는가(게이트 3).
 *
 * 이제 **소비자 종류와 무관하게 분봉·일봉을 다 받는다**(2026-08-21 에 일봉→분봉이
 * 열리며 마지막 비대칭이 사라졌다). 그래도 이 함수를 남겨 두는 이유는 W/M 이다:
 * `canPublishSyncCursor` 가 W/M 발행을 이미 막지만 판정 층은 발행 층의 규율에
 * 기대지 않고 혼자 서 있어야 한다.
 */
function acceptsOriginTimeframe(originTimeframe: LiveTimeframe): boolean {
  return isMinuteTimeframe(originTimeframe) || originTimeframe === 'D';
}

/** 다리를 건넌 결과 — 대상 캔들이거나 `null`. 게이트는 이미 통과한 뒤다. */
function crossBridge(source: SyncTargetSource, cursor: SyncCursor): SyncCandle | null {
  if (source.axis === 'calendar') {
    return source.byBucket.get(calendarBucketKey(cursor.tsMs, source.granularity)) ?? null;
  }
  return isMinuteTimeframe(cursor.origin.timeframe)
    ? snapToInstant(source.candles, cursor.tsMs)
    : snapToLastOfKstDay(source.candles, cursor.tsMs);
}

/**
 * 이 창이 무엇을 그려야 하는가. 아래 다섯 중 하나라도 걸리면 `none`(= 아무것도 안 함).
 *
 * 1. 발행이 없다.
 * 2. **내가 발행자다** — 자기 호버를 되받으면 lwc 자체 크로스헤어와 이중이 된다.
 * 3. **받지 않는 발행 봉이다**(W/M) — `acceptsOriginTimeframe`.
 * 4. **창번호(링크 그룹)가 다르다** — 아래 「범위는 창번호다」 절.
 * 5. **종목이 다르다** — 단 `allowCrossSymbol` 이 이 게이트를 **끈다**(아래).
 *
 * 게이트를 다 통과했는데 다리가 대상을 못 찾으면 둘로 갈린다: 그 날이 로드 범위
 * **밖**이면 `out-of-range`(방향만 알려 준다), 범위 **안**인데 없으면(휴장·구멍)
 * `none`. 이 구별이 있어야 "여기선 못 보여 준다" 와 "그 날은 원래 없다" 가 화면에서
 * 다른 말을 한다.
 *
 * ⚠ **게이트 차단은 절대 `out-of-range` 가 아니다.** 자기 발행을 되받는 경로가 칩을
 * 띄우면 호버할 때마다 자기 창에 "범위 밖" 이 뜬다 — 게이트를 먼저 통과시키는 순서가
 * 그걸 막는다(회귀 테스트로 고정).
 *
 * ── 범위는 **창번호**다(게이트 4) ─────────────────────────────────────────
 * 창 헤더의 그 작은 번호(링크 그룹)가 동기화 범위를 정한다 — 번호가 다른 창끼리는
 * 어떤 동기화도 하지 않는다(사용자 결정 2026-08-21).
 *
 * **이것은 2026-08-11 결정의 번복이다.** 그때는 "범위는 종목이다 — 링크 그룹이
 * 아니다"(ADR-0119 §4 「드로잉 = 종목 귀속」과 같은 답)였다. 창을 여러 개 띄우고
 * 그룹을 나눠 쓰는 실사용에서, 그룹 1 의 호버가 그룹 2 의 창까지 움직이는 것이
 * 방해가 된다는 판단이다. 되돌리려면 이 게이트 하나만 지우면 된다.
 *
 * `/study` 는 모든 창이 group `null` 이라 이 축이 상수다 — 서로 통과한다.
 *
 * ── 게이트 5 와 `allowCrossSymbol` ────────────────────────────────────────
 * **막는 방향**(`allowCrossSymbol === false`): 종목이 다른 창끼리 동기화되는 것.
 * 창번호 게이트가 생긴 뒤에도 이 축이 남는 이유는 **핀** 때문이다 —
 * `windowSymbolOf` 가 `pinned ?? groupSymbols[group]` 이라, 같은 그룹이어도 핀이
 * 걸린 창은 종목이 다르다. `/study` 는 모든 창이 같은 code 라 여기도 상수다.
 *
 * **토글이 바꾸는 것**: `cursorSyncCrossSymbol`(⚙️ 설정 → 차트, **기본 켬**)이 켜지면
 * 게이트 4 만 건너뛴다. 나머지 셋은 그대로다. 켠 상태의 귀결 하나는 **지수 창도
 * 받는다**는 것이다 — 다리가 시각뿐이라 `index:KOSPI` 창이 개별 종목 호버를 받고
 * 그 반대도 된다(사용자 결정 2026-08-21, 「다른 종목에도 적용」의 직역).
 *
 * **못 보는 것**: 이 판정은 종목만 본다 — 어느 창이 발행했는지는 소비 창 화면에
 * 남지 않는다(엣지 칩은 날짜만). 그리고 `allowCrossSymbol === false` 여도 양쪽
 * code 가 **둘 다 null** 이면 통과한다(관대한 `!== null` 가드). `/live` 의 지수 창은
 * `index:KOSPI` 로 채워지고 종목 없는 창은 `LiveChartRoot` 자체가 렌더되지 않아 현재
 * 도달 경로가 없지만, 새 code-null 창이 생기면 여기가 먼저 샌다 — 회귀 테스트로 이
 * 성질을 고정해 두었다.
 */
export function resolveSyncTarget(params: {
  cursor: SyncCursor | null;
  myWindowId: string | null;
  /** 이 창의 링크 그룹(창 헤더의 번호). Provider 밖(`/study`·단일 뷰)이면 null. */
  myGroup: number | null;
  myCode: string | null;
  source: SyncTargetSource;
  /**
   * 게이트 4(종목 일치)를 끈다 — `cursorSyncCrossSymbol` 토글의 값이다.
   *
   * **선택 인자가 아니다.** 순수 함수 기본값을 두면 그 기본과 레지스트리 기본
   * (`default: true`)이 조용히 갈리고, 인자를 안 적은 테스트가 제품 기본이 아닌
   * 모드를 검사하게 된다. 호출부·테스트가 매번 어느 모드인지 밝히게 둔다.
   */
  allowCrossSymbol: boolean;
}): SyncResolution {
  const { cursor, myWindowId, myGroup, myCode, source, allowCrossSymbol } = params;
  const none: SyncResolution = { kind: 'none' };
  if (!cursor) return none;
  const { origin } = cursor;
  if (origin.windowId !== null && origin.windowId === myWindowId) return none;
  if (!acceptsOriginTimeframe(origin.timeframe)) return none;
  // 창번호. **엄격 비교다** — code 게이트의 관대한 `!== null` 방식을 쓰지 않는다.
  // 그쪽은 code 가 늦게 붙는 창이 있어 관대해야 했지만, group 은 Provider 값이라
  // 렌더 첫 프레임부터 확정이고, 관대하면 "번호 없는 창" 이 모두와 동기화된다.
  if (origin.group !== myGroup) return none;
  if (!allowCrossSymbol && origin.code !== null && myCode !== null && origin.code !== myCode) {
    return none;
  }
  const candle = crossBridge(source, cursor);
  if (candle) return { kind: 'hit', candle };
  const side = outOfLoadedRange(source.candles, cursor.tsMs);
  return side ? { kind: 'out-of-range', side } : none;
}

/**
 * 화면 밖 인디케이터 라벨. **날짜만** — 발행 창의 시:분은 표시하지 않는다
 * (사용자 결정 2026-08-11). 일봉 축에 분 단위 시각이 뜨는 것이 축과 맞지 않고,
 * 분봉↔분봉에서도 같은 규칙을 쓴다(칩 하나가 창마다 다른 말을 하면 안 된다).
 */
export function formatKstMmdd(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

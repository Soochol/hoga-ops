/**
 * 창 간 크로스헤어 동기화 — **소비 측 판정**만 담는 순수 층. `/study` 와 `/live`
 * 워크스페이스가 같은 판정을 쓴다.
 *
 * 한 창의 호버를 다른 창이 받아 "내 축의 어느 캔들인가" 로 바꾸는 결정이 전부
 * 여기 있다. 그리는 일은 `CursorSyncCrosshair` 가 lightweight-charts 에
 * 맡긴다(`setCrosshairPosition`).
 *
 * ── 다리가 둘이다 — **소비 창의 봉**이 고른다 ─────────────────────────────
 * 좌표계가 둘이기 때문이다. 분봉 창은 intraday `VirtualAxis` 의 가상시각을 쓰고,
 * 캘린더 창은 하루 1포인트로 인덱싱된다. 발행 ms 를 남의 축에 **그대로 태우면
 * 안 된다** — `LiveChartRoot` 의 동시호가 배경 음영이 정확히 이 실수로 깨져
 * 2026-08-09 에 삭제됐고, 그 주석이 여전히 그 자리에 남아 있다.
 *
 * - **`date` 다리**(소비자 = `D`): 발행 ms → `unixMsToKSTDate` → 그 날의 일봉.
 *   압축이라 정확하고, 한 캔들 = 하루인 `D` 에서만 성립한다.
 * - **`instant` 다리**(소비자 = 분봉): 같은 **순간**으로 스냅한다. 발행 ms 에 가장
 *   가까운 내 봉을 찾되 **같은 KST 날짜일 때만** 인정한다.
 *
 * ── 받아 주는 발행은 소비자마다 다르다 ────────────────────────────────────
 * - `date` 소비자(`D`)는 **분봉·일봉 발행을 모두** 받는다 — 분봉→일봉(2026-08-11)
 *   과 일봉→일봉(2026-08-21). 후자는 창마다 뷰포트가 독립이라 의미가 있다: 옛
 *   주석이 "같은 축이면 그냥 같은 칸" 이라며 막았지만, A 창의 06/19 가 B 창에서
 *   같은 x 라는 보장은 애초에 없었다(종목까지 다르면 더더욱).
 * - `instant` 소비자(분봉)는 **분봉 발행만** 받는다 — 분봉→분봉(2026-08-21).
 *
 * ── 범위 밖: 일봉 → 분봉 ──────────────────────────────────────────────────
 * 하루가 분봉 축에서는 **한 점이 아니라 구간**이라 "선이 어디 서는가" 가 별도
 * 결정이고, 더 큰 문제는 커버리지다 — 일봉 창은 수개월을 보여주는데 분봉 창은
 * 보통 1~2일치만 들고 있어 **대부분의 일봉 호버가 대상 없음으로 떨어진다**. 지금
 * 구조에서 대상 없음은 "아무것도 안 그림" 이고, 그건 "동기화가 고장났다" 로 읽힌다.
 * 그 침묵을 화면에 설명하는 affordance(로드 범위 밖 안내)가 먼저다. 사용자 결정
 * 2026-08-21 — 못 하는 게 아니라 **순서를 미룬 것**이다.
 *
 * W/M 도 같은 이유로 범위 밖이다(한 캔들이 여러 날을 담는다).
 */
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

/**
 * 이 봉의 창에 소비자(`CursorSyncCrosshair`)를 마운트하는가.
 * 분봉(`instant` 다리)과 `D`(`date` 다리)뿐이다 — 위 헤더의 범위 절 참조.
 */
export function isSyncConsumerTimeframe(tf: LiveTimeframe): boolean {
  return isMinuteTimeframe(tf) || tf === 'D';
}

/**
 * 이 봉의 창이 동기화 채널에 **발행**해도 되는가.
 *
 * 슬롯이 전역 한 벌(마지막 쓴 사람이 이김)이라 **아무도 받지 않는 봉은 발행하면
 * 안 된다** — 표시에 기여하지 않으면서 유효한 발행을 밀어내기만 한다. `/live`
 * 실측(2026-08-11): 포인터가 분봉 창에 있는데 일봉 창 발행이 슬롯을 가져가 동기화
 * 표시가 그대로 사라졌다. 그때는 일봉에 소비자가 없어서 그랬고, 지금은 있다.
 *
 * 그래서 발행 집합은 **소비 집합과 같아야 한다** — 한쪽만 늘리면 그 실측이 그대로
 * 재현된다. 같은 술어를 쓰는 것이 그 불변식을 코드로 적는 방법이다. W/M 은 소비자가
 * 없으므로 여전히 발행하지 않는다.
 */
export function canPublishSyncCursor(tf: LiveTimeframe): boolean {
  return isSyncConsumerTimeframe(tf);
}

/** KST 날짜(`YYYYMMDD`) → 캔들. 같은 날이 둘일 수 없어 뒤에 온 것이 이긴다.
 *  **`date` 다리 전용** — 분봉 소비자는 인덱스를 만들지 않는다(`snapToInstant` 주석). */
export function indexCandlesByKstDate(
  candles: readonly SyncCandle[],
): ReadonlyMap<string, SyncCandle> {
  const m = new Map<string, SyncCandle>();
  for (const c of candles) m.set(unixMsToKSTDate(c.ts_ms), c);
  return m;
}

/** 소비 창이 대상을 찾는 방식. **소비 창의 봉**이 고르고, 받아 주는 발행 봉도 이것이 정한다. */
export type SyncTargetSource =
  /** 캘린더 소비자(`D`) — 날짜로 스냅. */
  | { axis: 'date'; byDate: ReadonlyMap<string, SyncCandle> }
  /** 분봉 소비자 — 같은 순간으로 스냅. `candles` 는 **ts 오름차순**이어야 한다. */
  | { axis: 'instant'; candles: readonly SyncCandle[] };

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

/**
 * 같은 순간으로 스냅 — 발행 ms 에 가장 가까운 내 봉.
 *
 * **인덱스를 만들지 않는다.** 분봉 번들은 틱마다 갱신되므로(실측 초당 ~8회) 날짜
 * 인덱스를 그때마다 재구축하면 캔들 수만큼의 일을 초당 여러 번 하게 된다. 캔들이
 * ts 오름차순이라 이진 탐색 O(log n) 으로 족하고, 이 함수는 커서가 바뀔 때만 돈다.
 *
 * **같은 KST 날짜가 아니면 버린다.** 그 날이 이 창에 없으면(옆 창만 과거로 팬)
 * 가장 가까운 봉이 며칠 떨어져 있을 수 있는데, 그리면 "동기화가 엉뚱한 데를
 * 가리킨다" 가 된다. **못 하는 것**: 그 침묵을 화면에 설명하지는 못한다 — 지금은
 * 아무것도 그리지 않고 끝이다(로드 범위 밖 안내는 미구현, 파일 헤더 범위 절).
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
 * 이 소비자가 저 발행 봉을 받는가(게이트 3). 헤더의 「받아 주는 발행」 절이 이 함수다.
 *
 * `canPublishSyncCursor` 가 W/M 발행을 이미 막지만 여기서도 거른다 — 판정 층은
 * 발행 층의 규율에 기대지 않고 혼자 서 있어야 한다.
 */
function acceptsOriginTimeframe(
  axis: SyncTargetSource['axis'],
  originTimeframe: LiveTimeframe,
): boolean {
  if (isMinuteTimeframe(originTimeframe)) return true;
  return axis === 'date' && originTimeframe === 'D';
}

/**
 * 이 창이 가리켜야 할 캔들. 아래 넷 중 하나라도 걸리면 `null`(= 아무것도 안 함).
 *
 * 1. 발행이 없다.
 * 2. **내가 발행자다** — 자기 호버를 되받으면 lwc 자체 크로스헤어와 이중이 된다.
 * 3. **내 소비자 종류가 받지 않는 발행 봉이다** — `acceptsOriginTimeframe`.
 * 4. **종목이 다르다** — 단 `allowCrossSymbol` 이 이 게이트를 **끈다**(아래).
 *
 * 그리고 다리가 대상을 못 찾으면(맥락 창 밖 · 휴장 · 그 날이 이 창에 없음) `null`.
 *
 * ── 게이트 4 와 `allowCrossSymbol` ────────────────────────────────────────
 * **막는 방향**(`allowCrossSymbol === false`): 종목이 다른 창끼리 동기화되는 것.
 * `/live` 는 창마다 종목이 다른 것이 1급 사용 패턴이라 여기가 유일한 방어선이고,
 * 링크 그룹은 보지 않는다(사용자 결정 2026-08-11 · ADR-0119 §4 「드로잉 = 종목
 * 귀속」과 같은 답). `/study` 는 모든 창이 활성 저장뷰의 같은 code 를 보므로 이
 * 축이 상수다 — 어느 값이든 결과가 같다.
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
}): SyncCandle | null {
  const { cursor, myWindowId, myCode, source, allowCrossSymbol } = params;
  if (!cursor) return null;
  const { origin } = cursor;
  if (origin.windowId !== null && origin.windowId === myWindowId) return null;
  if (!acceptsOriginTimeframe(source.axis, origin.timeframe)) return null;
  if (!allowCrossSymbol && origin.code !== null && myCode !== null && origin.code !== myCode) {
    return null;
  }
  return source.axis === 'date'
    ? source.byDate.get(unixMsToKSTDate(cursor.tsMs)) ?? null
    : snapToInstant(source.candles, cursor.tsMs);
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

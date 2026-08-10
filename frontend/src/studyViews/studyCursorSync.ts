/**
 * `/study` 창 간 크로스헤어 동기화 — **소비 측 판정**만 담는 순수 층.
 *
 * 분봉 창의 호버를 일봉 창이 받아 "내 축의 어느 캔들인가" 로 바꾸는 결정이 전부
 * 여기 있다. 그리는 일은 `StudyCursorSyncCrosshair` 가 lightweight-charts 에
 * 맡긴다(`setCrosshairPosition`).
 *
 * ── 왜 날짜로 스냅하는가 ──────────────────────────────────────────────────
 * 분봉 커서의 실제 ms 를 일봉 차트 축에 **그대로 태우면 안 된다.** intraday
 * `VirtualAxis` 의 가상시각과 캘린더 축(하루 1포인트)은 좌표계가 다르다 —
 * `LiveChartRoot` 의 동시호가 배경 음영이 정확히 이 실수로 깨져 2026-08-09 에
 * 삭제됐고, 그 주석이 여전히 그 자리에 남아 있다.
 *
 * 그래서 다리는 **KST 날짜**다: 분봉 ms → `unixMsToKSTDate` → 일봉 캔들. 이 스냅이
 * 정확한 것은 한 캔들 = 하루인 `D` 뿐이라, 호출부가 `D` 로 마운트를 제한한다.
 * (W/M 은 한 캔들이 여러 날을 담아 "그 날이 캔들 안 어디인가" 가 다른 질문이 된다.)
 */
import { unixMsToKSTDate } from '../util/time';
import { isMinuteTimeframe } from '../state/livePage';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';

/** 일봉 창이 그리고 있는 캔들 중 동기화에 필요한 최소 필드. */
export type SyncCandle = {
  ts_ms: number;
  /** 크로스헤어 가로선 높이. 분봉의 가격을 일봉에 옮기는 건 의미가 없어 종가를 쓴다. */
  close: number;
};

export type SyncCursor = {
  tsMs: number;
  origin: SidebarCursorOrigin;
};

/** KST 날짜(`YYYYMMDD`) → 캔들. 같은 날이 둘일 수 없어 뒤에 온 것이 이긴다. */
export function indexCandlesByKstDate(
  candles: readonly SyncCandle[],
): ReadonlyMap<string, SyncCandle> {
  const m = new Map<string, SyncCandle>();
  for (const c of candles) m.set(unixMsToKSTDate(c.ts_ms), c);
  return m;
}

/**
 * 이 창이 가리켜야 할 일봉 캔들. 아래 넷 중 하나라도 걸리면 `null`(= 아무것도 안 함).
 *
 * 1. 발행이 없다.
 * 2. **내가 발행자다** — 자기 호버를 되받으면 lwc 자체 크로스헤어와 이중이 된다.
 * 3. **분봉 발행이 아니다** — 일봉↔일봉 동기화는 의미가 없다(같은 축이면 그냥 같은 칸).
 * 4. **종목이 다르다** — `/study` 는 모든 창이 활성 저장뷰의 같은 code 를 보므로
 *    현재는 형식적이지만, 창별 저장뷰가 생기면 여기가 유일한 방어선이 된다.
 *
 * 그리고 그 날의 일봉이 이 창에 없으면(맥락 창 밖 · 휴장) 역시 `null` 이다.
 */
export function resolveSyncTarget(params: {
  cursor: SyncCursor | null;
  myWindowId: string | null;
  myCode: string | null;
  byDate: ReadonlyMap<string, SyncCandle>;
}): SyncCandle | null {
  const { cursor, myWindowId, myCode, byDate } = params;
  if (!cursor) return null;
  const { origin } = cursor;
  if (origin.windowId !== null && origin.windowId === myWindowId) return null;
  if (!isMinuteTimeframe(origin.timeframe)) return null;
  if (origin.code !== null && myCode !== null && origin.code !== myCode) return null;
  return byDate.get(unixMsToKSTDate(cursor.tsMs)) ?? null;
}

/**
 * 화면 밖 인디케이터 라벨. **날짜만** — 분봉의 시:분은 일봉 창에 표시하지 않는다
 * (사용자 결정 2026-08-11). 일봉 축에 분 단위 시각이 뜨는 것이 축과 맞지 않는다.
 */
export function formatKstMmdd(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 창 간 **기간 동기화** — 분봉 창을 좌우로 밀면 일봉 창이 그 날짜를 화면 중앙에
 * 둔다. 크로스헤어 동기화(`cursorSync.ts`)의 형제지만 **성질이 다르다**.
 *
 * ── 크로스헤어와 무엇이 다른가 ────────────────────────────────────────────
 * 크로스헤어는 호버라 **일시적**이고 "포인터가 떠나면 지운다" 는 계약이 있다. 뷰포트는
 * **지속 상태**라 그 계약이 없다 — 그래서 두 가지가 따라온다.
 *
 * 1. **발행은 사용자 제스처 중에만.** 분봉 창의 논리 범위는 사용자 팬 말고도 움직인다:
 *    새 캔들이 도착해 라이브 엣지를 따라가고, 백필이 prepend 하며 재앵커한다. 그걸
 *    전부 발행하면 **일봉을 다른 기간에 두고 볼 수가 없다** — 틱마다 오늘로 끌려간다.
 *    그래서 `useRangeSync` 가 제스처 구간(pointerdown~pointerup · 휠 꼬리)을 만들고
 *    그 안의 범위 변화만 싣는다.
 * 2. **stale 발행은 적용하지 않는다.** 슬롯에 남은 마지막 범위를 나중에 마운트된 창이
 *    적용하면 저장뷰 착석(`restoreViewport`)과 싸운다. 그래서 발행마다 `seq` 를 올리고
 *    소비자는 **자기가 붙은 뒤의 seq** 만 본다.
 *
 * ── 줌은 건드리지 않는다 ──────────────────────────────────────────────────
 * 분봉 창이 보는 폭은 보통 1~2일이다. 그 폭을 일봉 축에 그대로 맞추면 캔들 두 개짜리
 * 화면이 된다 — 못 쓴다. **스크롤만** 하고 일봉의 줌은 사용자 것으로 남긴다.
 *
 * ── 왜 `D` 만 소비하는가 ──────────────────────────────────────────────────
 * W/M 은 한 캔들이 여러 날을 담아 "그 날이 어느 버킷인가" 가 포함 탐색이 된다 —
 * 크로스헤어를 W/M 에서 뺀 것과 같은 사유다.
 */
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';

/** 분봉 창이 지금 보고 있는 실시각 구간. `seq` 는 stale 판정용 단조 증가 번호. */
export type RangeSyncPublication = {
  fromMs: number;
  toMs: number;
  seq: number;
  origin: SidebarCursorOrigin;
};

/** 이 봉의 창이 기간을 **발행**하는가 — 분봉만. */
export function canPublishRangeSync(tf: LiveTimeframe): boolean {
  return isMinuteTimeframe(tf);
}

/** 이 봉의 창이 기간을 **따라가는가** — `D` 만(위 헤더의 W/M 절 참조). */
export function isRangeSyncFollower(tf: LiveTimeframe): boolean {
  return tf === 'D';
}

/**
 * 이 창이 저 발행을 따라가야 하는가. 크로스헤어의 `resolveSyncTarget` 과 **같은
 * 게이트 순서**를 쓴다 — 발행 유무 · 자기 발행 · 발행 봉 · 종목.
 *
 * 종목 축은 크로스헤어와 **같은 토글**(`cursorSyncCrossSymbol`)이 정한다. 스위치를
 * 따로 두면 "창 A 와 창 B 가 연동되는가" 에 두 답이 생기는데, 화면에는 그 차이가
 * 보이지 않는다(ADR-0072 가 지표 드로어에서 겪은 것과 같은 종류의 혼란).
 */
export function shouldFollowRange(params: {
  publication: RangeSyncPublication | null;
  myWindowId: string | null;
  myCode: string | null;
  allowCrossSymbol: boolean;
}): boolean {
  const { publication, myWindowId, myCode, allowCrossSymbol } = params;
  if (!publication) return false;
  const { origin } = publication;
  if (origin.windowId !== null && origin.windowId === myWindowId) return false;
  if (!canPublishRangeSync(origin.timeframe)) return false;
  if (!allowCrossSymbol && origin.code !== null && myCode !== null && origin.code !== myCode) {
    return false;
  }
  return true;
}

/** 논리 범위 — lwc `getVisibleLogicalRange()` 와 같은 모양. */
export type LogicalRange = { from: number; to: number };

/**
 * 발행 구간을 **화면 중앙**에 두는 논리 범위. 줌(span)은 현재 값을 그대로 쓴다.
 *
 * 중심은 발행 구간이 내 축에서 차지하는 인덱스 구간의 중점이다 — 분봉 창이 하루만
 * 보면 그 하루 캔들이, 닷새를 보면 그 닷새의 가운데가 중앙에 온다.
 *
 * **`from` 을 0 으로 클램프하지 않는다.** 음수 `from` 은 로드된 가장 왼쪽 캔들보다
 * 과거를 보고 있다는 뜻이고, 그게 곧 백필 트리거다(`useViewportBackfill` 3b). 여기서
 * 잘라 내면 "그 기간을 보려고 팬했는데 데이터가 안 불러와지는" 상태가 된다. 대신
 * 오른쪽은 자연히 따라 움직이므로 별도 처리가 없다.
 *
 * 이미 중앙에 있으면(`null`) 아무것도 하지 않는다 — 매 프레임 같은 값을 되쓰면 lwc 가
 * 애니메이션을 재시작해 미세하게 떤다. 반올림 단위(1 인덱스)보다 작은 차이는 무시한다.
 */
export function centeredLogicalRange(params: {
  fromIndex: number;
  toIndex: number;
  current: LogicalRange;
}): LogicalRange | null {
  const { fromIndex, toIndex, current } = params;
  if (![fromIndex, toIndex, current.from, current.to].every(Number.isFinite)) return null;
  const span = current.to - current.from;
  if (!(span > 0)) return null;
  const center = (fromIndex + toIndex) / 2;
  const from = center - span / 2;
  if (Math.abs(from - current.from) < 1) return null;
  return { from, to: from + span };
}

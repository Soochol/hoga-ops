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
 * ── 줌: 기본은 안 건드리고, 켜면 **비율만** 옮긴다 ─────────────────────────
 * 분봉 창이 보는 폭은 보통 1~2일이다. 그 폭을 일봉 축에 **그대로 맞추면** 캔들 두
 * 개짜리 화면이 된다 — 그래서 "폭 일치" 는 기각이다.
 *
 * `rangeSyncZoom`(⚙️ 설정 → 차트, **기본 끔**)을 켜면 대신 **변화 비율**을 옮긴다:
 * 분봉을 2배 확대하면 일봉도 2배 확대된다. 절대 폭은 각 창의 것으로 남으므로 일봉이
 * 읽히는 배율을 유지하면서 제스처만 따라간다. 끄면 스크롤만 하고 배율은 그대로다.
 *
 * 비율이라 두 가지 방어가 필요하다 — **데드밴드**(팬만 해도 발행 폭이 조금 흔들린다:
 * 백필 prepend 재앵커) 와 **클램프**(분봉은 30~2000봉을 오가는데 그 배율을 그대로
 * 곱하면 일봉이 3봉 또는 12,000봉이 된다).
 *
 * ── 자기 데이터 밖으로는 밀지 않는다 ──────────────────────────────────────
 * 중앙 정렬은 그대로 두되 **우측 끝을 넘지 않는다**(마지막 캔들 + 표준 여백).
 *
 * 이게 없으면 최근 날짜를 중앙에 둘 때 화면 **오른쪽 절반이 빈 공간**이 된다 —
 * 일봉 차트는 원래 그 지점에서 멈추는데 중앙 정렬이 한계를 무시하고 밀어붙이기
 * 때문이다(2026-08-21 실사용에서 사용자 지적). 클램프가 걸리면 대상 날짜는 중앙이
 * 아니라 오른쪽 어딘가에 서지만, 그건 일봉 차트가 평소에 보이는 모습 그대로다.
 * 과거 날짜에서는 클램프가 안 걸려 중앙 정렬이 온전히 산다.
 *
 * ── 대상이 없을 때 — 침묵하지 않는다 ──────────────────────────────────────
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
 * 게이트 순서**를 쓴다 — 발행 유무 · 자기 발행 · 발행 봉 · **창번호** · 종목.
 *
 * **범위는 창번호(링크 그룹)다**(사용자 결정 2026-08-21). 세 동기화(크로스헤어 ·
 * 기간 · 줌)가 같은 규칙을 쓴다 — 하나만 다르면 "창 A 와 B 가 연동되는가" 에 답이
 * 둘 생기는데 화면에는 그 차이가 보이지 않는다. 그 근거와 번복 사연은
 * `cursorSync.ts` 헤더의 「범위는 창번호다」 절이 갖는다.
 *
 * 종목 축도 크로스헤어와 **같은 토글**(`cursorSyncCrossSymbol`)이 정한다 — 같은
 * 이유다. 창번호가 같아도 핀이 걸린 창은 종목이 다를 수 있어 이 축이 남는다.
 */
export function shouldFollowRange(params: {
  publication: RangeSyncPublication | null;
  myWindowId: string | null;
  /** 이 창의 링크 그룹(창 헤더의 번호). 크로스헤어와 **같은 범위 규칙**을 쓴다. */
  myGroup: number | null;
  myCode: string | null;
  allowCrossSymbol: boolean;
}): boolean {
  const { publication, myWindowId, myGroup, myCode, allowCrossSymbol } = params;
  if (!publication) return false;
  const { origin } = publication;
  if (origin.windowId !== null && origin.windowId === myWindowId) return false;
  if (!canPublishRangeSync(origin.timeframe)) return false;
  if (origin.group !== myGroup) return false;
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
  /** 줌 동기화가 계산한 새 폭. 없으면 현재 폭을 그대로 쓴다(스크롤만). */
  spanOverride?: number;
  /**
   * 이 창의 자연스러운 우측 끝(마지막 캔들 인덱스 + 1 + 표준 여백). 결과가 이보다
   * 오른쪽으로 가면 **폭을 유지한 채 왼쪽으로 되민다** — 파일 헤더의 그 절 참조.
   * 마지막 캔들을 아직 축에서 찾지 못했으면 `undefined`(클램프 없음).
   */
  rightEdgeLimit?: number;
}): LogicalRange | null {
  const { fromIndex, toIndex, current, spanOverride, rightEdgeLimit } = params;
  if (![fromIndex, toIndex, current.from, current.to].every(Number.isFinite)) return null;
  const currentSpan = current.to - current.from;
  const span = spanOverride ?? currentSpan;
  if (!(span > 0)) return null;
  const center = (fromIndex + toIndex) / 2;
  // 클램프는 **되밀기 전에** 계산한 뒤 적용한다. 순서를 바꿔 "이미 그 자리인가" 를
  // 먼저 보면, 천장에 붙은 상태에서 매번 같은 값을 되써 미세하게 떤다.
  const from = rightEdgeLimit !== undefined && center + span / 2 > rightEdgeLimit
    ? rightEdgeLimit - span
    : center - span / 2;
  // **위치와 폭 둘 다** 그대로일 때만 건너뛴다. 폭만 바뀌는 경우(제자리 줌)를
  // 위치 비교만으로 거르면 줌 동기화가 통째로 죽는다.
  const samePlace = Math.abs(from - current.from) < 1;
  const sameSpan = Math.abs(span - currentSpan) < 1;
  if (samePlace && sameSpan) return null;
  return { from, to: from + span };
}

/** 추종 창이 내려갈 수 있는 최소 폭(캔들 수) — 이보다 좁으면 일봉이 읽히지 않는다. */
export const MIN_FOLLOW_SPAN_BARS = 10;

/**
 * 줌 비율을 무시하는 문턱.
 *
 * **부동소수 오차용 ε 이 아니다.** 팬만 해도 발행 구간의 ms 폭이 완전히 고정되지는
 * 않는다 — 왼쪽으로 밀면 백필이 prepend 하며 재앵커해서 폭이 조금 달라진다. 그
 * 흔들림을 줌 제스처로 오독하면 팬할 때마다 일봉 배율이 야금야금 변한다.
 */
export const ZOOM_RATIO_DEADBAND = 0.05;

/**
 * 발행 폭의 **변화 비율**을 추종 창의 폭에 옮긴다 — 절대 폭을 맞추지 않는 이유는
 * 파일 헤더의 줌 절 참조.
 *
 * `null` 은 "이번 라운드는 폭을 건드리지 않는다" 다. 네 경우가 있다:
 * 1. 기준선이 없다(첫 발행 · 발행 창이 바뀜 · 토글이 방금 켜짐) — 비율을 잴 짝이 없다.
 * 2. 값이 유효하지 않다.
 * 3. 비율이 데드밴드 안이다(= 팬이지 줌이 아니다).
 * 4. 클램프에 걸려 결과가 지금과 같다 — 천장·바닥에서 되쓰면 1봉 진동만 남는다.
 */
export function zoomedSpan(params: {
  prevPublishedSpanMs: number | null;
  nextPublishedSpanMs: number;
  currentSpan: number;
  /** 추종 창이 들고 있는 캔들 수 — 폭의 천장이다(그 이상은 여백만 늘린다). */
  candleCount: number;
}): number | null {
  const { prevPublishedSpanMs, nextPublishedSpanMs, currentSpan, candleCount } = params;
  if (prevPublishedSpanMs === null) return null;
  if (!(prevPublishedSpanMs > 0) || !(nextPublishedSpanMs > 0) || !(currentSpan > 0)) return null;
  const ratio = nextPublishedSpanMs / prevPublishedSpanMs;
  if (Math.abs(ratio - 1) < ZOOM_RATIO_DEADBAND) return null;
  const ceiling = Math.max(candleCount, MIN_FOLLOW_SPAN_BARS);
  const target = Math.min(ceiling, Math.max(MIN_FOLLOW_SPAN_BARS, currentSpan * ratio));
  if (Math.abs(target - currentSpan) < 1) return null;
  return target;
}

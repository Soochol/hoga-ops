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
 * ── peer 는 **여백까지** 복제한다 ────────────────────────────────────────
 * 캔들 오른쪽 여백을 보고 있는 상태도 화면의 일부다. 시각 API 로는 그게 안 실린다
 * (`getVisibleRange()` 가 데이터 경계로 클램프한다) — 그래서 peer 발행은 **봉 단위**
 * (`RangeSyncBars`)다. 그 타입 주석이 실측과 함께 사유를 갖는다.
 *
 * ── cross 는 **배율을 건드리지 않는다** ───────────────────────────────────
 * 분봉 창이 보는 폭은 보통 1~2일이다. 그 폭을 일봉 축에 맞추면 캔들 두 개짜리
 * 화면이 되므로 "폭 일치" 는 애초에 기각이다. 한때 **변화 비율**을 옮기는
 * `rangeSyncZoom` 이 있었으나 사용자 결정으로 걷어냈다(2026-08-22) — 분봉을 확대할
 * 때 일봉까지 따라 확대되는 것이 원하는 동작이 아니었다. 지금 cross 는 위치만 옮긴다.
 *
 * ── 「같은 봉 창끼리 완전 동기화」(`rangeSyncPeer`) ────────────────────────
 * 이 토글이 **일봉 창들끼리의 결합**을 통째로 쥔다. 트리거가 둘이라 둘 다 여기 걸린다:
 *
 * 1. **peer 복제** — 한 일봉 창을 밀면 나머지가 같은 구간을 본다.
 * 2. **폭 합의** — 분봉 발행에 일봉들이 **같은 폭**을 쓴다. 폭을 각 창의 현재 값으로
 *    두면 같은 발행에도 창 크기만큼 화면이 갈린다(실측 2026-08-22: 184봉 vs 131봉).
 *    발행 하나(`seq`)에 대해 먼저 도착한 창이 seed 하고 나머지가 읽는다
 *    (`useLiveCursorStore.crossSpanAgreement`). **폭만 합의하고 위치는 각자 찾는다** —
 *    논리 인덱스는 창마다 다른 로드 이력 위의 값이라 옮기면 엉뚱한 날로 간다.
 *
 * 트리거가 분봉이라고 2를 이 토글 밖에 두면 "일봉끼리 동기화를 껐는데 분봉을 만지면
 * 일봉 폭이 서로 같아지는" 모순이 된다. 둘 다 **일봉↔일봉 결합**이라 한 스위치다.
 *
 * 끄면 `syncModeFor` 가 peer 를 **없는 모드로** 취급하고, 그러면 발행·소비 게이트가
 * 거기서 유도되므로 일봉 창은 **발행도 멈춘다** — 아무도 안 받는 발행이 단일 슬롯을
 * 훔쳐 분봉 발행을 지우는 것을 막는다(`canPublishRangeSync` 주석의 그 사고).
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
import { LIVE_TIMEFRAMES, type LiveTimeframe } from '../state/livePage';

/**
 * 발행 창의 뷰를 **봉 단위**로 적은 것 — peer 복제가 쓴다.
 *
 * 왜 시각(`fromMs`/`toMs`)으로는 안 되는가: lwc 의 `getVisibleRange()` 는 **데이터
 * 경계로 클램프된** 값을 준다. 캔들 오른쪽 여백을 보고 있으면 그 여백이 발행값에
 * 아예 안 실리고, 소비 창은 데이터 부분만 복제해 **다른 화면**이 된다(실측
 * 2026-08-22: 발행 창 120봉(데이터 74 + 여백 46) → 소비 창 74봉, 여백 0).
 * 뷰가 전부 여백이면 더 나쁘다 — `getVisibleRange()` 가 데이터 끝의 **1초 조각**을
 * 돌려주고, 그걸 복제한 소비 창은 캔들 하나로 쪼그라든다(실측 논리 0~1).
 *
 * 논리 범위(`getVisibleLogicalRange()`)에는 여백이 그대로 들어 있다. 다만 논리
 * 인덱스는 창마다 다른 로드 이력 위의 값이라 **그대로 옮길 수 없다** — 그래서
 * **기준 캔들의 실시각 + 거기서 떨어진 봉 수**로 적는다. 소비 창이 그 날짜를 자기
 * 축에서 다시 찾으면(`timeToIndex`) 나머지는 산수다.
 *
 * 기준을 **마지막 캔들**로 잡는 이유: 백필은 왼쪽에 prepend 하므로 마지막 캔들
 * 기준 오프셋은 백필에 **불변**이다. 뷰 안의 어떤 날짜를 기준으로 삼으면 그 날짜가
 * 여백 구간일 때 존재하지 않는다.
 */
export type RangeSyncBars = {
  /** 발행 창의 마지막 캔들 실시각 — 소비 창이 자기 축에서 다시 찾는 기준점. */
  anchorMs: number;
  /** 뷰 좌·우 끝이 기준점에서 몇 봉 떨어져 있는가. 여백을 포함하고 음수가 될 수 있다. */
  fromBars: number;
  toBars: number;
};

/** 분봉 창이 지금 보고 있는 실시각 구간. `seq` 는 stale 판정용 단조 증가 번호. */
export type RangeSyncPublication = {
  fromMs: number;
  toMs: number;
  /**
   * 봉 단위 뷰. **peer 복제는 이것만 쓴다** — 위 타입 주석의 클램프 사고 때문이다.
   * `timeToIndex` 를 못 쓰는 환경(테스트 목·구버전)에서는 없을 수 있고, 그때 peer 는
   * **아무것도 하지 않는다**(시각으로 되돌아가면 그 사고가 되살아난다).
   */
  bars?: RangeSyncBars;
  seq: number;
  origin: SidebarCursorOrigin;
};

/** 캘린더 봉 — 이 동기화의 참여 집합. 분봉은 양쪽 다 아니다(헤더의 그 절). */
function isCalendar(tf: LiveTimeframe): boolean {
  return tf === 'D' || tf === 'W' || tf === 'M';
}

/**
 * 이 소비 창이 저 발행을 받는가 — **같은 캘린더 봉끼리만**이다.
 *
 * 일↔주↔월을 서로 통하게 하면 일봉 3개월을 월봉에 복제했을 때 캔들 3개가 되어 그
 * 쌍에서는 다시 쓸모가 없어진다 — 「같은 주기」라는 조건이 붙은 이유가 그것이다.
 *
 * 분봉을 다시 넣으려면 **폭이 비교 불가**라는 문제부터 풀어야 한다: 분봉이 보는
 * 1~2일을 일봉 축에 그대로 맞추면 캔들 두 개짜리 화면이 된다. 그래서 과거 판은
 * 중앙 정렬 + 별도 폭 규칙이었고, 그 규칙들이 차례로 기각됐다(헤더 참조).
 */
export function acceptsRangeOrigin(
  myTimeframe: LiveTimeframe,
  originTimeframe: LiveTimeframe,
): boolean {
  return isCalendar(myTimeframe) && myTimeframe === originTimeframe;
}

/**
 * 이 봉의 창에 소비자를 마운트하는가 — **내가 받을 발행이 하나라도 있는가.**
 *
 * 발행 쪽(`canPublishRangeSync`)과 같은 이유로 손 목록이 아니라 유도다.
 */
export function isRangeSyncFollower(tf: LiveTimeframe): boolean {
  return LIVE_TIMEFRAMES.some((origin) => acceptsRangeOrigin(tf, origin));
}

/**
 * 이 봉의 창이 기간을 **발행**하는가.
 *
 * ⚠ **손으로 목록을 적지 않는다.** 지금은 발행 집합과 소비 집합이 같지만(양쪽 다
 * 캘린더 봉) 그건 **결과이지 정의가 아니다** — 분봉이 발행만 하던 시절에는 달랐고,
 * 그때 이 파일은 `canPublishRangeSync = isRangeSyncFollower` 라고 적혀 있다가
 * 조용히 틀렸다.
 *
 * 진짜 불변식은 포함 관계다 — **내 발행을 받는 소비자가 하나라도 있는가.** 그래서
 * 술어를 `acceptsRangeOrigin` 에서 **유도**한다. 어긋남의 증상은 "아무도 안 받는
 * 발행이 단일 슬롯을 훔쳐 유효한 표시를 지우는 것"이다(2026-08-11 실측).
 */
export function canPublishRangeSync(tf: LiveTimeframe): boolean {
  return LIVE_TIMEFRAMES.some((my) => acceptsRangeOrigin(my, tf));
}

/**
 * 이 창이 저 발행을 따라가야 하는가. 크로스헤어의 `resolveSyncTarget` · 기간 점프의
 * `resolveTimeframeJump` 와 **같은 게이트 순서**를 쓴다 — 발행 유무 · 자기 발행 ·
 * 발행 봉 · **창번호** · 종목.
 *
 * **범위는 창번호(링크 그룹)다**(사용자 결정 2026-08-21). 세 동기화가 같은 규칙을
 * 쓴다 — 하나만 다르면 "창 A 와 B 가 연동되는가" 에 답이 둘 생기는데 화면에는 그
 * 차이가 보이지 않는다. 그 근거와 번복 사연은 `cursorSync.ts` 헤더의 「범위는
 * 창번호다」 절이 갖는다.
 *
 * 종목 축도 크로스헤어와 **같은 토글**(`cursorSyncCrossSymbol`)이 정한다 — 같은
 * 이유다. 창번호가 같아도 핀이 걸린 창은 종목이 다를 수 있어 이 축이 남는다.
 */
export function shouldFollowRange(params: {
  publication: RangeSyncPublication | null;
  myWindowId: string | null;
  /** 이 창의 봉 — 받는지 아닌지를 이것이 정한다. */
  myTimeframe: LiveTimeframe;
  /** 이 창의 링크 그룹(창 헤더의 번호). 크로스헤어와 **같은 범위 규칙**을 쓴다. */
  myGroup: number | null;
  myCode: string | null;
  allowCrossSymbol: boolean;
}): boolean {
  const { publication, myWindowId, myTimeframe, myGroup, myCode, allowCrossSymbol } = params;
  if (!publication) return false;
  const { origin } = publication;
  if (origin.windowId !== null && origin.windowId === myWindowId) return false;
  if (!acceptsRangeOrigin(myTimeframe, origin.timeframe)) return false;
  if (origin.group !== myGroup) return false;
  if (!allowCrossSymbol && origin.code !== null && myCode !== null && origin.code !== myCode) {
    return false;
  }
  return true;
}

/** 논리 범위 — lwc `getVisibleLogicalRange()` 와 같은 모양. */
export type LogicalRange = { from: number; to: number };

/**
 * 적용 대상 — 발행 창의 뷰를 **여백까지 그대로** 복제한다(논리 범위).
 *
 * 같은 봉끼리는 폭이 비교 가능하므로 "같은 구간을 본다" 가 곧 동기화의 정의다.
 * 그래서 위치와 폭이 한 값에서 나온다.
 *
 * **클램프하지 않는다.** 우측 클램프는 "자기 데이터 밖으로 밀지 않는다" 는 규칙인데,
 * 복제는 그 반대가 계약이다 — 상대가 보는 구간에 내 데이터가 없으면 **여백이 보이는
 * 것이 정직하다**(가짜로 당겨 붙이면 두 창이 다른 구간을 보면서 같아 보인다). 논리
 * 범위라 왼쪽 음수도 그대로 나가고, 그게 곧 백필 트리거다(`useViewportBackfill` 3b).
 *
 * 이미 그 구간이면 `null` — 되쓰면 lwc 가 애니메이션을 재시작해 떤다.
 */
export function replicatedLogicalRange(params: {
  /** 발행 창의 기준 캔들이 **내 축에서** 갖는 논리 인덱스. */
  anchorIndex: number;
  bars: RangeSyncBars;
  current: LogicalRange | null;
}): LogicalRange | null {
  const { anchorIndex, bars, current } = params;
  if (![anchorIndex, bars.fromBars, bars.toBars].every(Number.isFinite)) return null;
  const from = anchorIndex + bars.fromBars;
  const to = anchorIndex + bars.toBars;
  if (!(to > from)) return null;
  // 한 봉 미만 차이는 무시 — 화면에서 구별되지 않고, 되쓰면 떤다.
  if (current && Math.abs(current.from - from) < 1 && Math.abs(current.to - to) < 1) return null;
  return { from, to };
}

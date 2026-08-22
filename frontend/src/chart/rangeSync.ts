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
import { LIVE_TIMEFRAMES, isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';

/** 분봉 창이 지금 보고 있는 실시각 구간. `seq` 는 stale 판정용 단조 증가 번호. */
export type RangeSyncPublication = {
  fromMs: number;
  toMs: number;
  seq: number;
  origin: SidebarCursorOrigin;
};

/** 캘린더 봉 — peer 동기화의 참여 집합(사용자 결정 2026-08-21: 분봉 peer 는 제외). */
function isCalendar(tf: LiveTimeframe): boolean {
  return tf === 'D' || tf === 'W' || tf === 'M';
}

/**
 * 참여 스위치. **필수 인자다** — 기본값을 주면 새 호출부가 조용히 옛 동작을 쓰고,
 * 그 어긋남은 화면에 안 보인다(이 파일이 이미 한 번 밟은 유형).
 */
export type RangeSyncSwitches = {
  /** 「같은 봉 창끼리 완전 동기화」(`rangeSyncPeer`) — peer 복제 + 폭 합의. */
  peer: boolean;
};

/** 동기화 모드. 어떤 다리를 놓고 어떻게 적용할지가 여기서 갈린다. */
export type RangeSyncMode =
  /** 분봉 → 일봉. 폭이 비교 불가라 **중앙 정렬 + 비율**이다. */
  | 'cross'
  /** 같은 캘린더 봉끼리(D↔D · W↔W · M↔M). 폭이 비교 가능해 **구간을 복제**한다. */
  | 'peer';

/**
 * 이 소비 창이 저 발행을 받는가, 받는다면 어느 모드인가.
 *
 * **분봉은 추종하지 않는다** — 발행만 한다(사용자 결정 2026-08-21). 그래서 분봉 창을
 * 여러 개 놓고 각자 다른 구간을 보는 작업 방식이 그대로 살고, 분봉 백필이 창 수만큼
 * 겹쳐 도는 일도 없다.
 *
 * **캘린더는 같은 봉끼리만이다.** 일↔주↔월을 서로 통하게 하면 일봉 3개월을 월봉에
 * 복제했을 때 캔들 3개가 되어 그 쌍에서는 다시 쓸모가 없어진다 — 「같은 주기」라는
 * 조건이 붙은 이유가 그것이다.
 */
export function syncModeFor(
  myTimeframe: LiveTimeframe,
  originTimeframe: LiveTimeframe,
  opts: RangeSyncSwitches,
): RangeSyncMode | null {
  if (!isCalendar(myTimeframe)) return null;
  if (myTimeframe === originTimeframe) return opts.peer ? 'peer' : null;
  if (myTimeframe === 'D' && isMinuteTimeframe(originTimeframe)) return 'cross';
  return null;
}

/**
 * 이 봉의 창에 소비자를 마운트하는가 — **내가 받을 발행이 하나라도 있는가.**
 *
 * 발행 쪽(`canPublishRangeSync`)과 같은 이유로 손 목록이 아니라 유도다. peer 를 끄면
 * W/M 창은 받을 것이 하나도 없어져(그 봉은 peer 뿐이다) 소비자를 아예 안 단다.
 */
export function isRangeSyncFollower(tf: LiveTimeframe, opts: RangeSyncSwitches): boolean {
  return LIVE_TIMEFRAMES.some((origin) => syncModeFor(tf, origin, opts) !== null);
}

/**
 * 이 봉의 창이 기간을 **발행**하는가.
 *
 * ⚠ **「발행 집합 = 소비 집합」이 아니다.** 이 파일은 한때 그렇게 적혀 있었고
 * (`canPublishRangeSync = isRangeSyncFollower`), 그때는 두 집합이 우연히 같았다.
 * 분봉이 **발행만 하고 추종은 하지 않는** 지금 구성에서 그 등식은 틀렸다.
 *
 * 진짜 불변식은 포함 관계다 — **내 발행을 받는 소비자가 하나라도 있는가.** 그래서
 * 술어를 `syncModeFor` 에서 **유도**한다. 손으로 목록을 적어 두면 받는 쪽 규칙이
 * 바뀔 때 조용히 어긋나고, 그 어긋남의 증상은 "아무도 안 받는 발행이 단일 슬롯을
 * 훔쳐 유효한 표시를 지우는 것"이다(2026-08-11 실측).
 */
export function canPublishRangeSync(tf: LiveTimeframe, opts: RangeSyncSwitches): boolean {
  return LIVE_TIMEFRAMES.some((my) => syncModeFor(my, tf, opts) !== null);
}

/**
 * 이 창이 저 발행을 따라가야 하는가, 따라간다면 어느 모드인가. 크로스헤어의
 * `resolveSyncTarget` 과 **같은 게이트 순서**를 쓴다 — 발행 유무 · 자기 발행 ·
 * 발행 봉(=모드 판정) · **창번호** · 종목.
 *
 * **범위는 창번호(링크 그룹)다**(사용자 결정 2026-08-21). 세 동기화(크로스헤어 ·
 * 기간 · 줌)가 같은 규칙을 쓴다 — 하나만 다르면 "창 A 와 B 가 연동되는가" 에 답이
 * 둘 생기는데 화면에는 그 차이가 보이지 않는다. 그 근거와 번복 사연은
 * `cursorSync.ts` 헤더의 「범위는 창번호다」 절이 갖는다.
 *
 * 종목 축도 크로스헤어와 **같은 토글**(`cursorSyncCrossSymbol`)이 정한다 — 같은
 * 이유다. 창번호가 같아도 핀이 걸린 창은 종목이 다를 수 있어 이 축이 남는다.
 */
export function resolveRangeSyncMode(params: {
  publication: RangeSyncPublication | null;
  myWindowId: string | null;
  /** 이 창의 봉 — 어느 모드인지(또는 받지 않는지)를 이것이 정한다. */
  myTimeframe: LiveTimeframe;
  /** 이 창의 링크 그룹(창 헤더의 번호). 크로스헤어와 **같은 범위 규칙**을 쓴다. */
  myGroup: number | null;
  myCode: string | null;
  allowCrossSymbol: boolean;
  switches: RangeSyncSwitches;
}): RangeSyncMode | null {
  const {
    publication, myWindowId, myTimeframe, myGroup, myCode, allowCrossSymbol, switches,
  } = params;
  if (!publication) return null;
  const { origin } = publication;
  if (origin.windowId !== null && origin.windowId === myWindowId) return null;
  const mode = syncModeFor(myTimeframe, origin.timeframe, switches);
  if (mode === null) return null;
  if (origin.group !== myGroup) return null;
  if (!allowCrossSymbol && origin.code !== null && myCode !== null && origin.code !== myCode) {
    return null;
  }
  return mode;
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
  /**
   * 적용할 폭. 호출부가 **창끼리 합의한 값**(파일 헤더의 그 절)을 넘긴다.
   * 없거나 합의가 꺼져 있으면 현재 폭 유지 — 위치만 옮긴다.
   */
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
  // **위치와 폭 둘 다** 그대로일 때만 건너뛴다. 위치는 같은데 폭만 바뀌는 경우가
  // 실제로 있다(폭 합의가 옆 창의 값을 물어다 준다) — 위치 비교만으로 거르면 그
  // 라운드가 통째로 사라진다.
  const samePlace = Math.abs(from - current.from) < 1;
  const sameSpan = Math.abs(span - currentSpan) < 1;
  if (samePlace && sameSpan) return null;
  return { from, to: from + span };
}

/**
 * peer 모드의 적용 대상 — 발행 구간을 **그대로** 복제한다(가상초).
 *
 * `cross` 처럼 중앙 정렬하지 않는 이유: 같은 봉끼리는 폭이 비교 가능하므로 "같은
 * 구간을 본다" 가 곧 동기화의 정의다. 그래서 위치와 폭이 한 값에서 나온다 —
 * 별도의 줌 비율 계산이 필요 없다.
 *
 * **클램프하지 않는다.** 우측 클램프는 "자기 데이터 밖으로 밀지 않는다" 는 규칙인데,
 * 복제는 그 반대가 계약이다 — 상대가 보는 구간에 내 데이터가 없으면 **여백이 보이는
 * 것이 정직하다**(가짜로 당겨 붙이면 두 창이 다른 구간을 보면서 같아 보인다).
 *
 * 이미 그 구간이면 `null` — 되쓰면 lwc 가 애니메이션을 재시작해 떤다.
 */
export function replicatedRange(params: {
  fromVirtualSec: number;
  toVirtualSec: number;
  current: { from: number; to: number } | null;
}): { from: number; to: number } | null {
  const { fromVirtualSec: from, toVirtualSec: to, current } = params;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) return null;
  // 1초 미만 차이는 무시 — 가상초는 정수로 반올림돼 들어온다.
  if (current && Math.abs(current.from - from) < 1 && Math.abs(current.to - to) < 1) return null;
  return { from, to };
}

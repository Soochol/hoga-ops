/**
 * 캘린더 봉 창 → 분봉 창 **기간 점프** — "일봉에서 보고 있는 날짜를 분봉에서 바로
 * 열어라" 는 **명시적 1회 명령**. 기간 동기화(`rangeSync.ts`)의 형제지만 **방향도
 * 성질도 반대**라 채널을 따로 판다.
 *
 * ── 왜 `rangeSync` 에 방향을 하나 더 열지 않는가 ──────────────────────────
 * `syncModeFor` 는 분봉을 소비자로 만들면 `null` 을 돌려준다. 그건 빠뜨린 것이
 * 아니라 **결정**이다(2026-08-21): 분봉 창 여러 개를 각자 다른 구간에 두는 작업
 * 방식을 지키고, 분봉 백필이 창 수만큼 겹쳐 도는 것을 막는다. 일봉을 밀 때마다
 * 분봉이 따라오면 그 둘이 그대로 되돌아온다.
 *
 * 점프는 **연속 추종이 아니다** — 사용자가 버튼을 누른 그 순간에만, 한 번 움직인다.
 * 그래서 같은 게이트 규칙을 쓰되 채널·래치·수명이 전부 다르고, 그 차이를 한
 * 모듈에 욱여넣으면 "이 창이 지금 무엇을 하는가" 가 읽히지 않는다.
 *
 * ── 폭은 옮기지 않는다 ────────────────────────────────────────────────────
 * 일봉 화면은 보통 60~200 거래일이고 1분봉으로 환산하면 수만 봉이다. 분봉 창이 한
 * 화면에 담을 수 있는 것은 `maxRenderableSpan`(= `plotWidth / minBarSpacing`) 으로
 * 보통 200봉 안팎 — 배율 차이가 2~3자릿수라 "그 기간을 그대로 보여준다" 는 애초에
 * 성립하지 않는다. 그래서 옮기는 것은 **위치 하나**이고 폭은 소비 창의 현재 값이다.
 *
 * ── 착지: 그 **칸의 마지막 봉**을 화면 오른쪽 끝에 ────────────────────────
 * 발행이 칸의 구간(`fromMs`~`toMs`)을 보내고, 소비 창이 그 안의 마지막 봉에 앉는다.
 * 일봉이면 「그 날 마지막 봉」이라 종전과 결과가 같다.
 *
 * ⚠ **여기서 크로스헤어와 갈라진다 — 의도한 분기다.** 종전엔 `cursorSync.ts` 의
 * `snapToLastOfKstDay` 를 그대로 썼고 근거는 "두 기능이 다른 봉에 서면 안 된다" 였다.
 * 그 근거는 **일봉에서만** 성립한다: 주·월봉의 `ts_ms` 는 칸의 **시작**이라 날짜 일치
 * 스냅은 칸의 첫 거래일로 간다(실측 2026-08-23: 주봉 08-18, 월봉 08-03 — 최신 봉을
 * 보고 있는데도 월봉은 3주가 어긋났다). 크로스헤어는 "지금 가리키는 봉이 무엇인가" 라
 * 칸 시작이 옳고, 점프는 "그 칸을 분봉에서 열어라" 라 칸 끝이 옳다. **크로스헤어 쪽은
 * 건드리지 않는다.**
 *
 * 칸 안에 봉이 하나도 없으면 앉지 않고 기다린다(백필 대기) — 종전 `snapToLastOfKstDay`
 * 가 그 날 봉이 없을 때 하던 것과 같은 성질이다. 칸 밖(더 과거)의 봉으로 내려앉지
 * 않으므로 백필 도중에 엉뚱한 곳에 조기 착지하는 일이 없다.
 */
import {
  CALENDAR_TIMEFRAMES,
  isMinuteTimeframe,
  type CalendarTimeframe,
  type LiveTimeframe,
} from '../state/livePage';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';
import type { LogicalRange } from './rangeSync';

/**
 * 점프 요청 한 건. `seq` 는 **래치 키**다 — 소비 창이 seq 하나를 한 번만 적용한다.
 *
 * 왜 래치가 필요한가: 착지에는 재시도가 따른다(그 날 봉이 아직 백필 전이면 다음
 * 커밋에 다시 본다). 그 재시도를 `candles` 변화로 돌리면 **착지한 뒤에도** 계속
 * 돈다 — 분봉 번들은 SSE 틱마다 갱신되므로(실측 초당 ~8회) 사용자가 팬으로 빠져
 * 나가려 할 때마다 도로 끌려온다. seq 당 한 번이 그 루프를 끊는다.
 */
export type JumpPublication = {
  /**
   * 칸의 **시작**(= 발행 창에서 보이는 가장 오른쪽 캔들의 `ts_ms`).
   *
   * 소비 창의 **백필 목표**다. 착지 상한(`toMs`)을 백필에 물리면 로드 구간이
   * `[칸 끝, 지금]` 이 되어 정작 착지 대상인 그 칸의 봉이 영영 안 온다 — 먼 과거
   * 주·월봉이 영원히 「불러오는 중」에 머문다.
   */
  fromMs: number;
  /**
   * 칸의 **포함 상한**. 소비 창은 이 값 이하의 마지막 봉에 앉는다.
   *
   * 일봉이면 그 날 끝이라 종전 계약(「그 날의 어느 시각」)과 결과가 같다. 주·월봉에서만
   * 달라진다 — 규칙과 근거는 `minuteJumpDestination.bucketEndMs`.
   */
  toMs: number;
  seq: number;
  origin: SidebarCursorOrigin;
};

/**
 * 목적지 날짜 한 줄 표기 — 올해면 `06-19`, 아니면 `25-06-19`.
 *
 * 해를 접는 기준이 **오늘**인 이유: 점프는 단일 날짜라 `SavedRangeChip` 의 기간
 * 표기(구간 양끝이 해를 걸치면 안 접는다)와 판정 축이 다르다. 여기서 무조건 접으면
 * 작년 06-19 와 올해 06-19 가 화면에서 같은 글자가 된다.
 */
export function jumpDateLabel(yyyymmdd: string, todayYyyymmdd: string): string {
  const md = `${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  return yyyymmdd.slice(0, 4) === todayYyyymmdd.slice(0, 4) ? md : `${yyyymmdd.slice(2, 4)}-${md}`;
}

/**
 * 「분봉으로」 버튼이 **누르기 전에** 말하는 목적지 — 칸 단위 표기.
 *
 * ⚠ **날짜 하나로 쓰지 않는다(주·월).** 착지는 그 칸의 마지막 *거래일*인데, 그것이
 * 어느 날인지는 **분봉 창만** 안다(거래일 달력이 그쪽 캔들에만 있다). 발행 창이 아는
 * 것은 달력상의 칸 경계뿐이라, 상한 날짜를 그대로 쓰면 **거래일이 아닌 날**을 약속하게
 * 된다 — 실측(2026-08-23, 일요일): 주봉·월봉 모두 `08-23` 을 보여줬는데 실제 착지는
 * `08-21` 이다. 일봉이 `08-21` 인 옆에서 주봉이 `08-23` 이면 더 헷갈린다.
 *
 * 그래서 칸을 **칸으로** 말한다: 일 `08-21` · 주 `08-18 주` · 월 `08월`. 정확한 날짜는
 * 착지한 뒤 점프 칩이 말한다(그때는 앉은 봉을 알고 있다).
 */
export function jumpBucketLabel(
  tf: CalendarTimeframe,
  fromYyyymmdd: string,
  todayYyyymmdd: string,
): string {
  const thisYear = fromYyyymmdd.slice(0, 4) === todayYyyymmdd.slice(0, 4);
  if (tf === 'D') return jumpDateLabel(fromYyyymmdd, todayYyyymmdd);
  if (tf === 'W') return `${jumpDateLabel(fromYyyymmdd, todayYyyymmdd)} 주`;
  const mm = fromYyyymmdd.slice(4, 6);
  return thisYear ? `${mm}월` : `${fromYyyymmdd.slice(2, 4)}년 ${mm}월`;
}

/** 이 봉의 창이 점프를 **발행**하는가 — 캘린더 봉(일·주·월)뿐이다. */
export function canPublishTimeframeJump(tf: LiveTimeframe): boolean {
  return (CALENDAR_TIMEFRAMES as readonly LiveTimeframe[]).includes(tf);
}

/**
 * 이 봉의 창이 점프를 **받는가** — 분봉뿐이다.
 *
 * 캘린더끼리(일→주)는 받지 않는다. 그건 "같은 날짜를 다른 봉으로 본다" 가 아니라
 * 기간 동기화의 peer 가 이미 담당하는 축이고, 여기에까지 얹으면 한 조작에 두 채널이
 * 같은 창을 움직인다.
 */
export function isTimeframeJumpTarget(tf: LiveTimeframe): boolean {
  return isMinuteTimeframe(tf);
}

/**
 * 이 창이 저 점프를 받는가. 크로스헤어(`resolveSyncTarget`)·기간
 * (`resolveRangeSyncMode`)과 **같은 게이트 순서**를 쓴다 — 발행 유무 · 자기 발행 ·
 * 발행 봉 · 소비 봉 · 창번호 · 종목.
 *
 * **범위는 창번호(링크 그룹)다.** 세 동기화가 이미 그 규칙이고, 네 번째만 다르게
 * 두면 "창 A 와 B 가 연동되는가" 에 답이 둘 생기는데 화면에는 그 차이가 보이지
 * 않는다. 근거와 번복 사연은 `cursorSync.ts` 헤더의 「범위는 창번호다」 절.
 */
export function resolveTimeframeJump(params: {
  publication: JumpPublication | null;
  myWindowId: string | null;
  myTimeframe: LiveTimeframe;
  myGroup: number | null;
  myCode: string | null;
  allowCrossSymbol: boolean;
}): JumpPublication | null {
  const { publication, myWindowId, myTimeframe, myGroup, myCode, allowCrossSymbol } = params;
  if (!publication) return null;
  const { origin } = publication;
  if (origin.windowId !== null && origin.windowId === myWindowId) return null;
  if (!canPublishTimeframeJump(origin.timeframe)) return null;
  if (!isTimeframeJumpTarget(myTimeframe)) return null;
  if (origin.group !== myGroup) return null;
  if (!allowCrossSymbol && origin.code !== null && myCode !== null && origin.code !== myCode) {
    return null;
  }
  return publication;
}

/**
 * 착지 논리 범위 — 앵커 봉을 **화면 오른쪽 끝**에 놓고 폭은 현재 값을 지킨다.
 *
 * ⚠ 오른쪽 여백은 `CHART_TIMESCALE_OPTIONS.rightOffset` 이 **아니라**
 * `minuteRightOffsetBars` 가 준 값이다. 분봉 창은 가격 라벨 거터 180px 를 봉 수로
 * 환산해 따로 비우는데(`minuteViewportPolicy`), 원시 상수를 쓰면 착지한 봉이 그
 * 라벨 **밑에** 깔린다 — 도착했는데 안 보이는 상태가 된다.
 *
 * 이미 그 자리면 `null`. 되쓰면 lwc 가 애니메이션을 재시작해 미세하게 떤다.
 * (판정 단위는 1 인덱스 — 그보다 작은 차이는 화면에서 구별되지 않는다.)
 */
export function jumpedLogicalRange(params: {
  /** 목적지 봉이 **내 축에서** 갖는 논리 인덱스. */
  anchorIndex: number;
  current: LogicalRange;
  /** 오른쪽에 비워 둘 봉 수 — 호출부가 `minuteRightOffsetBars` 로 구한다. */
  rightOffsetBars: number;
}): LogicalRange | null {
  const { anchorIndex, current, rightOffsetBars } = params;
  if (![anchorIndex, current.from, current.to, rightOffsetBars].every(Number.isFinite)) return null;
  const span = current.to - current.from;
  if (!(span > 0)) return null;
  const to = anchorIndex + 1 + rightOffsetBars;
  const from = to - span;
  if (Math.abs(from - current.from) < 1 && Math.abs(to - current.to) < 1) return null;
  return { from, to };
}

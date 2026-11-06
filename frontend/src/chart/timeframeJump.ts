import {
  CALENDAR_TIMEFRAMES,
  isMinuteTimeframe,
  type CalendarTimeframe,
  type LiveTimeframe,
} from '../state/livePage';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';
import type { GroupSymbol } from '../state/workspace';
import type { LiveVenueOption } from '../state/liveVenue';
import type { LogicalRange } from './rangeSync';

export type CalendarJumpSource = {
  code: string;
  venue: LiveVenueOption;
  source: 'vendor' | 'disk';
  sourceKey: string;
  from: string;
  to: string;
  cutoffMs: number;
};

export type JumpPublication = {
  fromMs: number;
  toMs: number;
  seq: number;
  origin: SidebarCursorOrigin;
  calendarSource?: CalendarJumpSource;
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

/** The existing minute data-window receiver remains minute-only. */
export function isTimeframeJumpTarget(tf: LiveTimeframe): boolean {
  return isMinuteTimeframe(tf);
}

export type JumpReceiver = {
  windowId: string | null;
  timeframe: LiveTimeframe;
  group: number | null;
  code: string | null;
  stockCode?: string | null;
  usInstrument?: boolean;
  frozen?: boolean;
};

export function domesticStockCode(symbol: GroupSymbol | null): string | null {
  return symbol && (symbol.kind === undefined || symbol.kind === 'stock') ? symbol.code : null;
}

export function canReceiveTimeframeJump(args: {
  origin: SidebarCursorOrigin;
  sourceStockCode: string | null;
  target: JumpReceiver;
  allowCrossSymbol: boolean;
}): boolean {
  const { origin, sourceStockCode, target, allowCrossSymbol } = args;
  if (origin.windowId !== null && origin.windowId === target.windowId) return false;
  if (!canPublishTimeframeJump(origin.timeframe) || origin.group !== target.group || target.usInstrument) return false;
  if (isMinuteTimeframe(target.timeframe)) {
    return !target.frozen && (allowCrossSymbol || origin.code === null || target.code === null || origin.code === target.code);
  }
  if (target.group === null || sourceStockCode === null || target.stockCode !== sourceStockCode) return false;
  return (origin.timeframe === 'M' && (target.timeframe === 'W' || target.timeframe === 'D'))
    || (origin.timeframe === 'W' && (target.timeframe === 'M' || target.timeframe === 'D'));
}

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
  if (!isTimeframeJumpTarget(myTimeframe)) return null;
  if (!canReceiveTimeframeJump({
    origin: publication.origin, sourceStockCode: publication.calendarSource?.code ?? null,
    target: { windowId: myWindowId, timeframe: myTimeframe, group: myGroup, code: myCode },
    allowCrossSymbol,
  })) return null;
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

/**
 * `/live` 저장뷰 기간이 **화면에 온전히 들어오지 못할 때**의 안내 문구.
 *
 * `/study` 의 `studySavedRangeCoverage` 와 같은 역할이지만 **판정 축이 다르다.**
 * 저쪽은 디스크 일봉 코퍼스의 시작·끝을 보고, 이쪽은 `/live` 의 두 한계를 본다:
 *  ① 분봉 스크롤백 상한 250 캘린더일(`PAST_CANDLES_MAX_DAYS`) — 저장 구간이 그보다
 *     과거면 벤더가 원리적으로 못 준다.
 *  ② 캘린더 봉에서 저장 구간에 봉이 하나도 없음 — 밴드가 **아무 말 없이** 사라진다.
 *
 * 안내가 필요 없으면 `null`. "되는 데까지 보여주고 안 되는 것만 말한다" 가 정책이다
 * (2026-08-21 사용자 결정) — 그래서 부분 커버리지도 차단이 아니라 문구로 나간다.
 */
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';

export type SavedRangeNotice = {
  /** 칩 한 줄 — **무엇이** 문제인지만. */
  text: string;
  /** 툴팁·스크린리더 — **결과**와 **대안**. 칩은 좁고 이쪽은 안 좁다. */
  detail: string;
};

/** `20260701` → `2026.07.01`. `/study` 의 같은 헬퍼와 같은 이유로 연도를 남긴다 —
 *  저장 구간과 조회 한계가 다른 해인 것이 이 안내의 본체다. */
function dotted(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}.${yyyymmdd.slice(4, 6)}.${yyyymmdd.slice(6, 8)}`;
}

export function savedRangeNotice(args: {
  timeframe: LiveTimeframe;
  fromDate: string;
  toDate: string;
  /** 분봉 조회 하한(`earliestAllowedMinuteDate(today)`). 캘린더 봉에서는 무시된다. */
  minuteFloorDate: string;
  /** 캘린더 봉에서 밴드 마크가 잡혔는가(`studySavedRangeMarks !== null`). */
  hasBand: boolean;
  /** 이 창에 그려진 캔들 수. 0이면 차트가 통째로 비어 있다. */
  candleCount: number;
}): SavedRangeNotice | null {
  const { timeframe, fromDate, toDate, minuteFloorDate, hasBand, candleCount } = args;
  const from = dotted(fromDate);
  const to = dotted(toDate);

  if (isMinuteTimeframe(timeframe)) {
    // YYYYMMDD 는 사전식 비교가 곧 날짜 순서다.
    if (toDate < minuteFloorDate) {
      return {
        text: '저장 구간이 분봉 범위 밖',
        detail: `분봉은 최근 ${dotted(minuteFloorDate)} 부터만 조회됩니다. 저장 구간 ${from}~${to} 는 그보다 과거라 분봉으로 표시할 수 없습니다. 일봉(D)으로 바꾸면 기간 밴드로 볼 수 있습니다.`,
      };
    }
    if (fromDate < minuteFloorDate) {
      return {
        text: '저장 구간 일부만 표시',
        detail: `분봉은 최근 ${dotted(minuteFloorDate)} 부터만 조회됩니다. 저장 구간 ${from}~${to} 의 앞부분이 그 경계에서 잘립니다.`,
      };
    }
    return null;
  }

  // 캘린더 봉: 캔들이 아예 없으면 그 화면은 빈 상태가 소유한다 — 여기서 한마디 더
  // 얹으면 같은 사실을 두 곳에서 다르게 말하게 된다(`/study` 의 같은 판단).
  if (candleCount === 0 || hasBand) return null;
  return {
    text: '저장 구간 데이터 없음',
    detail: `저장 구간 ${from}~${to} 에 해당하는 일봉이 이 화면에 없어 기간 밴드가 표시되지 않습니다.`,
  };
}

/**
 * `/live` 저장뷰 기간이 **화면에 온전히 들어오지 못할 때**의 안내 문구.
 *
 * ⚠ **분봉에는 더 이상 할 말이 없다** — 여기 있던 250일 벽 안내 두 개는 2026-08-21 에
 * 제거됐다. 저장뷰 창이 그 구간에 얼려 디스크(hogaplay)를 읽게 되면서
 * (`UseLiveBundleOptions.frozenRangeFrom`) 벽이 그 창에 적용되지 않기 때문이다. 문구만
 * 남겨 두면 **볼 수 있는 구간을 못 본다고 말하는 안내**가 되고, 그건 침묵보다 나쁘다.
 * 되살리지 말 것 — 벽은 벤더 경로에만 남아 있고 저장뷰 창은 그 경로를 안 탄다.
 *
 * 분봉에서 구간이 **통째로** 비는 경우는 이 칩이 아니라 **빈 상태**가 말한다
 * (`candleEmptyState` 의 `savedRangeFrozen` 분기). 같은 사실을 두 곳에서 다르게 말하지
 * 않기 위해서고, 그건 아래 캘린더 봉 분기가 이미 따르던 규율이다.
 *
 * 그래서 남은 판정은 둘이다:
 *  ① **분봉에서 앞부분만 미캡처** — 빈 상태는 전량이 비어야 발화하므로 이 자리를 못 본다.
 *     캡처는 어느 날부터 시작되고 저장뷰는 그보다 과거를 가리킬 수 있어(실측: 사용자의
 *     벽 밖 분봉 저장뷰 2개가 **둘 다** 이 경우다) 침묵하면 "앞이 잘렸는데 이유가 없는
 *     차트" 가 된다. 정책이 "되는 데까지 보여주고 **안 되는 것만 말한다**" 라 문구가 나간다.
 *  ② **캘린더 봉에서 저장 구간에 봉이 하나도 없음** — 밴드가 아무 말 없이 사라지는 자리.
 *
 * `/study` 의 `studySavedRangeCoverage` 와 같은 역할이지만 판정 축이 다르다(저쪽은
 * 디스크 일봉 코퍼스의 시작·끝을 본다).
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
  /** 캘린더 봉에서 밴드 마크가 잡혔는가(`studySavedRangeMarks !== null`). */
  hasBand: boolean;
  /** 이 창에 그려진 캔들 수. 0이면 차트가 통째로 비어 있다. */
  candleCount: number;
  /**
   * 이 창의 **가장 이른 캔들**의 거래일(YYYYMMDD). 캔들이 없으면 `null`.
   *
   * 분봉 부분 미캡처 판정의 유일한 재료다. `fromDate` 와의 **비교**가 요점이라
   * 개수(`candleCount`)로는 대신할 수 없다 — 뒷부분만 캡처돼도 개수는 많다.
   */
  earliestCandleDate?: string | null;
}): SavedRangeNotice | null {
  const { timeframe, fromDate, toDate, hasBand, candleCount } = args;
  const earliestCandleDate = args.earliestCandleDate ?? null;
  const from = dotted(fromDate);
  const to = dotted(toDate);

  // 분봉은 얼린 창이 디스크를 읽으므로 **기간 상한이 없다** — 상단 도크스트링 참조.
  // 남은 실패는 커버리지뿐이고, 그중 전량 미캡처는 빈 상태가 소유한다.
  if (isMinuteTimeframe(timeframe)) {
    // YYYYMMDD 는 사전식 비교가 곧 날짜 순서다.
    if (candleCount > 0 && earliestCandleDate !== null && earliestCandleDate > fromDate) {
      return {
        text: '저장 구간 앞부분 미캡처',
        detail: `저장 구간 ${from}~${to} 중 ${dotted(earliestCandleDate)} 부터만 캡처돼 있어 그 앞은 표시되지 않습니다. 분봉 복기는 디스크 캡처를 읽으므로 캡처 이전 구간은 채울 수 없습니다.`,
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

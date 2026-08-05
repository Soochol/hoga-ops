import type { Candle } from '../api/types';
import { realMsToYyyymmdd, regularSessionCloseMs } from './liveDateTime';
import { AUCTION_WINDOW_LENGTH_MS } from '../util/sessionTime';

/**
 * 마감 동시호가(단일가) 구간의 봉들을 **한 봉으로 접고 단일가로 평탄화**한다.
 *
 * ## 왜 필요한가 — 벤더 응답이 체결이 아닌 것을 봉으로 준다
 *
 * KRX 마감 동시호가(정규장 마지막 10분)는 **정의상 단일 가격에 전량 체결**된다.
 * 체결은 마감 시각 한 번뿐이므로 그 구간의 O/H/L/C 가 갈릴 이유가 없다. 그런데
 * 키움 `ka10080` 은 창 안 각 분에도 봉을 실어 보내고, 그 값은 체결이 아니라
 * **예상체결가**다. 그대로 그리면 두 증상이 난다:
 *
 *   1. 15:20~15:29 에 분마다 얇은 doji(`-`)가 늘어선다 — 체결이 없는데 봉이 있다.
 *   2. 마지막 봉이 예상가(open) → 확정 단일가(close) 로 벌어져 **몸통**이 생긴다.
 *      동시호가 봉은 `chart/projectors/candle.ts` 가 mute 색으로 칠하므로, 그
 *      몸통이 짙은 회색 덩어리로 발현돼 "검은 캔들"로 보인다.
 *
 * 그래서 이 접기는 미화가 아니라 **정정**이다. 남기는 값(마지막 봉의 close)이
 * 그날 유일한 실제 동시호가 체결가고, 나머지는 전부 예상치의 흔적이다.
 *
 * ## 거래량은 합산하지 않는다
 *
 * 창 안 봉의 거래량은 실거래량일 수 **없다** — 그 시간대에 체결이 없기 때문이다
 * (예상체결량이거나 0). 합산하면 확정 체결량 위에 예상량을 얹어 과대계상한다.
 * 그래서 **마지막 봉의 거래량만** 그대로 쓴다.
 *
 * ## 세션 경계는 응답이 말한 값을 먼저 쓴다
 *
 * 창은 "마지막 10분"이지 "15:20~15:30"이 아니다 — 반휴장일(12:30 마감)에도 같은
 * 10분 밴드가 성립하므로 `sessionClose` 에 앵커한다(`sessionTime.ts` 의
 * `AUCTION_WINDOW_LENGTH_MS` 와 같은 불변식). `sessionCloseByDate` 는
 * past-candles 응답의 `effective_sessions` 에서 오고, 없는 날짜만
 * `regularSessionCloseMs`(고정 15:30)로 폴백한다. 고정값만 썼다면 반휴장일에
 * 접기가 통째로 빗나가 그날만 증상이 재발했을 것이다.
 *
 * ## 호출 계약
 *
 * 입력은 `t_ms` 오름차순 정렬(=`aggregateCandles` 와 같은 계약). 분봉·KRX 에서만
 * 부르라 — NXT 는 마감 단일가 체계가 없어 같은 시간대 봉이 연속거래 봉이고,
 * 접으면 그건 왜곡이다. 캘린더(D/W/M)는 하루 1봉이라 애초에 창에 걸리지 않는다.
 */
export function collapseClosingAuction(
  candles: readonly Candle[],
  sessionCloseByDate?: ReadonlyMap<string, { close_ms: number }>,
): Candle[] {
  if (candles.length === 0) return candles as Candle[];

  const closeMsFor = (date: string): number =>
    sessionCloseByDate?.get(date)?.close_ms ?? regularSessionCloseMs(date);

  const out: Candle[] = [];
  // 현재 날짜 창에서 마지막으로 본 봉. 창을 벗어나거나 날짜가 바뀔 때 flush 한다.
  let pending: Candle | null = null;
  let pendingDate = '';
  // 평탄화가 실제로 새 객체를 만들었는가. 길이 변화(=여러 봉이 접힘)와 함께
  // "아무것도 안 바꿨으면 입력 배열 자체를 돌려준다"를 판정한다 — 아래 참조.
  let flattened = false;

  const flush = (): void => {
    if (pending === null) return;
    const bar = flatten(pending);
    if (bar !== pending) flattened = true;
    out.push(bar);
    pending = null;
  };

  for (const c of candles) {
    const date = realMsToYyyymmdd(c.ts_ms);
    const closeMs = closeMsFor(date);
    const inAuction = c.ts_ms >= closeMs - AUCTION_WINDOW_LENGTH_MS && c.ts_ms <= closeMs;

    if (!inAuction) {
      flush();
      out.push(c);
      continue;
    }
    // 날짜가 바뀌었는데 사이에 창 밖 봉이 없었던 경우(정렬 계약상 오지 않지만,
    // 한 날짜의 접힌 봉이 다음 날짜 것에 조용히 먹히는 것보다 낫다).
    if (pending !== null && pendingDate !== date) flush();
    pending = c;
    pendingDate = date;
  }
  flush();

  // 바꾼 게 없으면 **입력 배열 그대로** 돌려준다. 매번 새 배열을 내면
  // `bundle.candles` 의 identity 가 렌더마다 흔들려 크로스헤어·오버레이·캔들
  // 프로젝터 캐시(`candle.ts` 의 WeakMap)가 통째로 무효화된다 — 접을 게 없는
  // 대부분의 렌더에서 순수한 낭비다(useLiveBundle 의 chartBundle 참조 안정성
  // 테스트가 이걸 지킨다).
  if (!flattened && out.length === candles.length) return candles as Candle[];
  return out;
}

/** O=H=L=C=close. 동시호가 봉의 유일한 실제 값은 확정 단일가(close)다. */
function flatten(c: Candle): Candle {
  if (c.open === c.close && c.high === c.close && c.low === c.close) return c;
  return { ...c, open: c.close, high: c.close, low: c.close };
}

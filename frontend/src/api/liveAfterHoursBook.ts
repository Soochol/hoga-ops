import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import type { OrderbookLevel, OrderbookSnapshot } from './types';

/**
 * GET /api/live/after-hours-book — 키움 ka10087 시간외 단일가 **5단** 호가.
 *
 * ## 왜 REST 인가
 *
 * 16:00–18:00 에는 WS 가 아무것도 주지 않는다 — `0D`(호가)는 15:30, `0B`(체결)는
 * 16:00 에 끊긴다(2026-08-14 실측,
 * `docs/research/2026-08-14-kiwoom-after-hours-orderbook-sources.md`). 그 두 시간의
 * 유일한 호가 소스가 이 라우트다.
 *
 * ## 5단이다 — 10단이 아니다
 *
 * 벤더 상한이 5차선이라 10호가 격자는 중앙 쪽 5행만 차고 바깥 5행이 빈다
 * (사용자 결정 2026-08-14). 빈 행은 결손이 아니라 **그 시장에 없는 단계**이므로
 * 라벨로 그 사실을 말한다.
 *
 * ## `active` 가 판별 필드다
 *
 * `false` 면 창 밖이거나 볼 호가가 없다는 뜻이고, 그때 소비자는 **정규장 스냅샷을
 * 그대로 둬야 한다**. 백엔드가 창 밖에서 벤더를 아예 치지 않으므로 이 값은
 * "데이터 없음"이 아니라 "지금은 없는 표면"이다.
 */
export interface LiveAfterHoursLevel {
  price: number;
  qty: number;
}

/** 시간외 단일가 체결 한 건 — **벤더가 준 것이 아니라 백엔드가 합성한 것**이다.
 *
 *  개별 체결을 주는 소스가 없어(2026-08-19 실측: `ka10003`·`ka10084`·WS `0B` 전부
 *  15:59:50 정지) 누적 체결량의 증분에서 만든다. 그래서:
 *
 *  - ⚠ `t_ms` 는 **관측 시각이지 체결 시각이 아니다**(실측 27초 지연). 정렬 전용.
 *  - ⚠ `side` 가 **없다** — 단일가 일괄 체결이라 방향이 정의되지 않는다. 0 을 채워
 *    "중립 체결"로 그리지 말고, 색 없이 렌더할 것.
 *  - 관측이 없던 주기는 **빈다**. 그게 정상이다 — 백엔드가 여러 주기를 한 줄로
 *    합치지 않는다(`_FillLedger`).
 */
export interface LiveAfterHoursFill {
  t_ms: number;
  price: number;
  qty: number;
}

export interface LiveAfterHoursBookResponse {
  code: string;
  active: boolean;
  /** 호가잔량기준시간 HHMMSS(벤더 `bid_req_base_tm`).
   *
   *  ⚠ **신선도로 쓰지 말 것.** 2026-08-19 실측(117표본 20분)에서 `"160000"` 에
   *  고정된 채 한 번도 움직이지 않았고, 같은 기간 호가 잔량은 계속 변했다.
   *  "언제 값인가" 를 보이려면 `fetched_at_ms` 를 쓴다. */
  base_tm: string | null;
  /** 길이 5, index 0 = 최우선호가. `active=false` 면 빈 배열. */
  ask: LiveAfterHoursLevel[];
  bid: LiveAfterHoursLevel[];
  total_ask_qty: number;
  total_bid_qty: number;
  cur_price: number | null;
  change_pct: number | null;
  acc_volume: number;
  /** 당일 **종가** — 이 구간 등락률의 분모다. **전일종가가 아니다.**
   *
   *  시간외 단일가는 당일 종가 ±10% 안에서 거래되므로 전일종가 기준 등락률은 이
   *  화면에서 의미가 없다(종가가 곧 0%다). 벤더도 `change_pct` 를 종가 기준으로
   *  주는데 사다리만 정규장 분모를 쓰고 있었다.
   *
   *  `null` 이면 **등락률을 생략한다** — 분모를 추측해 0.00% 로 박제하지 않는다. */
  close_price: number | null;
  /** 예상체결가·량 — 출처는 **`ka10001`** 이다(이 응답의 나머지는 ka10087).
   *
   *  2026-08-19 실측으로 확정된 이 구간의 **유일한** 예상체결 소스다. 같은 이름
   *  필드를 가진 `ka10007`·`ka10095` 는 정규장 잔상이고, WS `0H` 는 오지 않는다.
   *
   *  ⚠ 값이 **체결 직전 30초에 요동친다**(실측: 최종 표본 400 vs 실제 899).
   *  확정 체결이 아니라 접수 상황의 스냅샷이므로 화면은 "예상"이라고 말해야 한다.
   *
   *  둘 중 하나라도 null 이면 배너를 감춘다 — "예상체결 없음"은 정상 상태다. */
  exp_price: number | null;
  exp_qty: number | null;
  /** 합성 체결(최신 먼저) — 성격과 한계는 `LiveAfterHoursFill`. */
  fills: LiveAfterHoursFill[];
  fetched_at_ms: number;
  source: 'kiwoom';
}

/** 시간외 단일가 창(16:00–18:00 KST, 주말 제외)인가 — 백엔드
 *  `session_gate.is_after_hours_single_price_window` 의 손 미러.
 *
 *  **백엔드가 방어선이고 이건 두 번째 줄이다.** 창 밖에서도 라우트는 벤더를 치지
 *  않고 `active:false` 를 주므로 안전은 이미 확보돼 있다 — 이 술어의 목적은 무의미한
 *  왕복을 아예 만들지 않는 것뿐이다. 그래서 여기서 틀려도 유량 사고가 아니다. */
export function isAfterHoursSinglePriceWindow(nowMs: number = Date.now()): boolean {
  // KST = UTC+9. 로컬 타임존에 의존하지 않도록 UTC 기준으로 옮겨 계산한다 —
  // 사용자 브라우저가 KST 가 아닐 수 있고, 그때 로컬 시각으로 판정하면 창이 통째로
  // 어긋난다(`util/time` 의 unixMsToKSTDate 와 같은 규율).
  const kst = new Date(nowMs + 9 * 3600 * 1000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false; // 일·토
  const min = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return min >= 16 * 60 && min < 18 * 60;
}

/** 폴링 주기. 시간외 단일가는 10분 주기로 체결되지만 호가는 계속 접수되므로
 *  분 단위로는 너무 느리다. 백엔드 TTL 캐시(3s)가 벤더 콜을 접으므로 이 주기가
 *  그대로 벤더 유량이 되지는 않는다. */
const REFETCH_MS = 5_000;

export function useAfterHoursBook(code: string | null) {
  const enabled = !!code && isAfterHoursSinglePriceWindow();
  return useQuery({
    queryKey: ['live', 'after-hours-book', code] as const,
    enabled,
    // 창 안에서만 돈다. 창을 벗어나면 `enabled` 가 false 가 되지만 React Query 는
    // 이미 잡힌 인터벌을 즉시 끊지 않으므로, 주기 함수에서도 한 번 더 판정한다.
    refetchInterval: () => (isAfterHoursSinglePriceWindow() ? REFETCH_MS : false),
    // 자격증명 없는 환경(워크트리·dev 무자격)에서 이 라우트는 503 이다. 조용히
    // 실패해야 화면이 죽지 않는다 — 재시도로 콘솔을 채우지 않는다.
    retry: false,
    queryFn: ({ signal }) =>
      apiCall<LiveAfterHoursBookResponse>(
        `/api/live/after-hours-book?code=${code}`,
        { signal },
      ),
  });
}

const EMPTY_LEVEL: OrderbookLevel = { price: 0, qty: 0 };

/**
 * ka10087 응답 → BookPanel 이 먹는 `OrderbookSnapshot`(10단 격자).
 *
 * **5단을 10칸으로 zero-pad 한다** — 사용자 결정이 "10단 격자 유지, 5행만 채움"
 * 이라, 바깥 5칸은 빈 레벨로 남는다. BookPanel 은 price=0 행을 이미 빈 행으로
 * 그리므로(정규장에서도 짧은 book 이 그렇게 온다) 격자 로직은 손대지 않는다.
 *
 * `active=false` 면 **null** 을 준다 — 호출부가 정규장 스냅샷을 유지하도록.
 */
/*
 * 이 자리에 `latestExpectedFill(frames)` 이 있었다 — WS `0H` 버퍼에서 이 구간의
 * 예상체결을 꺼내는 함수였다. **삭제한 이유는 소스가 존재하지 않기 때문**이다:
 * 2026-08-19 실측에서 `0H` 는 이 창에 프레임을 하나도 내지 않았다(구독 중, 체결
 * 3주기, 링버퍼 0건 — `docs/research/2026-08-19-after-hours-single-price-fills-and-
 * expected.md` §4.3). 그 함수는 `isAfterHoursSinglePriceWindow(t)` 로 **하드 게이트**
 * 를 걸고 있었으므로, 그 창에 프레임이 없다는 것은 곧 **어떤 입력에도 매칭되지
 * 않는다**는 뜻이다.
 *
 * 정규장 동시호가 배너는 이 함수를 탄 적이 없다 — 그쪽은 `0D` FID 23/24 가
 * 스냅샷에 실려 오는 별도 경로다. 예상체결은 이제 응답의 `exp_price`/`exp_qty`
 * (ka10001)에서 온다.
 */

export function afterHoursBookToSnapshot(
  book: LiveAfterHoursBookResponse | undefined,
): OrderbookSnapshot | null {
  if (!book || !book.active) return null;
  const pad = (levels: readonly LiveAfterHoursLevel[]): OrderbookLevel[] => {
    const out: OrderbookLevel[] = [];
    for (let i = 0; i < 10; i++) {
      const lv = levels[i];
      out.push(lv ? { price: lv.price, qty: lv.qty } : EMPTY_LEVEL);
    }
    return out;
  };
  return {
    ts_ms: book.fetched_at_ms,
    seq: 0,
    ask: pad(book.ask),
    bid: pad(book.bid),
    tot_ask: book.total_ask_qty,
    tot_bid: book.total_bid_qty,
    // 예상체결이 있으면 정규장 동시호가와 **같은 배너**(ExpectedFillBanner)가 뜬다 —
    // 소비 표면을 하나로 둔다. 없으면 0 이라 배너는 높이 0 으로 사라진다.
    // 출처만 다르다: 정규장은 0D FID 23/24, 여기는 REST ka10001.
    exp_price: book.exp_price ?? 0,
    exp_qty: book.exp_qty ?? 0,
  };
}

/** 합성 체결 → 체결창 행. **`side` 를 만들지 않는다** — 단일가 일괄 체결이라
 *  방향이 정의되지 않고, 0 을 넣으면 BookPanel 이 "중립 체결" 색으로 그려
 *  "방향을 아는데 중립" 처럼 읽힌다. 색 없는 렌더는 호출부가 정한다. */
export function afterHoursFillRows(
  book: LiveAfterHoursBookResponse | undefined,
): { price: number; qty: number; side: number }[] {
  if (!book || !book.active) return [];
  return book.fills.map((f) => ({ price: f.price, qty: f.qty, side: 0 }));
}

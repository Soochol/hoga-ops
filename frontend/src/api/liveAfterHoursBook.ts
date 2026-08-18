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

export interface LiveAfterHoursBookResponse {
  code: string;
  active: boolean;
  /** 호가잔량기준시간 HHMMSS(벤더 `bid_req_base_tm`) — 신선도 표시용. */
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
/** 시간외 단일가 구간의 예상체결(키움 0H) 한 쌍. 둘 다 >0 일 때만 의미가 있다. */
export interface LiveExpectedFill {
  price: number;
  qty: number;
}

/**
 * `expected` 버퍼(0H)의 **이 구간에 속하는** 마지막 프레임. 없으면 null.
 *
 * ⚠ **시각 게이트가 핵심이다.** 게이트가 없으면 정규장 종가 동시호가(15:20–15:30)의
 * 마지막 0H 프레임이 버퍼에 남아 16:30 화면에 실시간처럼 뜬다 — 그건 ka10007 의
 * `exp_cntr_*` 가 이 구간에 정규장 잔상을 그대로 답하던 것(2026-08-18 실측: 두 체결
 * 주기에 걸쳐 미동)과 **똑같은 버그를 우리 손으로 재생산**하는 것이다.
 *
 * 그래서 판정은 프레임 **자기 t_ms** 로 한다(수신 시각이 아니라). 벽시계로 판정하면
 * 창 안에서 받은 낡은 프레임을 걸러내지 못한다.
 */
export function latestExpectedFill(
  frames: readonly Record<string, unknown>[],
): LiveExpectedFill | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const t = f.t_ms;
    if (typeof t !== 'number' || !isAfterHoursSinglePriceWindow(t)) continue;
    const price = f.expected_price;
    const qty = f.expected_qty;
    if (typeof price === 'number' && price > 0 && typeof qty === 'number' && qty > 0) {
      return { price, qty };
    }
  }
  return null;
}

export function afterHoursBookToSnapshot(
  book: LiveAfterHoursBookResponse | undefined,
  expected: LiveExpectedFill | null = null,
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
    // 0H 가 있으면 정규장 동시호가와 **같은 배너**(ExpectedFillBanner)가 뜬다 —
    // 소비 표면을 하나로 둔다. 없으면 0 이라 배너는 높이 0 으로 사라진다.
    exp_price: expected?.price ?? 0,
    exp_qty: expected?.qty ?? 0,
  };
}

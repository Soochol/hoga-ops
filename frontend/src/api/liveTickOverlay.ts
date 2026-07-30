/**
 * 리스트용 코드→최신 체결가 구독 (WS live 채널).
 *
 * 배경: 관심종목·히트맵·스크리너의 등락률은 /api/live/quotes 10초 폴링만 바라봤다
 * (ADR-0056 단일 merge seam). 그 결과 두 증상이 겹쳤다.
 *   (A) 문서가 hidden 이면 폴링이 통째로 멈춘다 — react-query 의
 *       refetchIntervalInBackground 기본 false 에 main.tsx 의
 *       refetchOnWindowFocus:false 가 겹쳐, 창을 가렸다 돌아와도 다음 tick(≤10s)
 *       까지 옛 값이 남는다. 멀티창 워크스페이스에서 특히 두드러진다.
 *   (B) 폴링 주기 10초 자체가 틱으로 움직이는 차트·호가와 눈에 띄게 어긋난다.
 *
 * 키움 WS 는 이미 관심종목 전건을 구독해 백엔드 버퍼로 publish 하고 있고
 * (stream.py → buffer per-code), ws.ts 의 live 채널 프레임에는 코드 태그가 붙어
 * 한 소켓이 0..N 코드를 나른다. 즉 전송 계층·백엔드 변경 없이 프론트가 코드별로
 * subscribeLive 를 더 부르기만 하면 된다 — 데이터는 이미 서버에 와 있는데
 * 구독자가 없어 버려지고 있었다.
 *
 * 이 모듈은 "체결가만" 책임진다. 등락률 합성은 liveQuotes.ts 의 기존 seam
 * (useLiveQuoteOverlay)이 계속 소유한다 — seam 을 둘로 늘리지 않기 위해서고,
 * liveQuotes → 여기 단방향 import 로 순환도 없다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { subscribeLive } from './ws';
import type { LiveSnapshotEntry } from './types';
import { liveVenueAcceptsFrame } from '../live/liveVenuePolicy';
import type { LiveVenueOption } from '../state/liveVenue';

/** 트레일링 스로틀 창. liveSeries.ts 의 LIVE_FLUSH_MS 와 같은 값·같은 이유:
 *  종목 하나만도 장중 초당 수십 푸시가 오는데 리스트는 그 N배라, 코얼레싱 없이는
 *  드로어 전체가 그 빈도로 재렌더된다. 리스트 등락률에 sub-150ms 신선도는 무의미. */
const LIVE_FLUSH_MS = 150;

/** WS 틱을 구독할 코드 수 상한.
 *
 *  실측(2026-07-20 장중, 히트맵 235종목 전건 구독):
 *    수신 387프레임/초 · 196KB/초 → **long task 0건 · 메인스레드 차단 0ms · 60fps**.
 *  종목을 늘려도 렌더 비용이 선형으로 늘지 않는다 — 핸들러가 trade 아닌 kind 를
 *  즉시 반환하고, 실제 재렌더는 LIVE_FLUSH_MS 스로틀로 코얼레싱돼 **종목 수와 무관하게
 *  초당 ~6.7회로 고정**되기 때문이다. (초기값 60은 실측 없는 보수적 추정이었다.)
 *
 *  그래서 상한의 근거는 프론트 렌더가 아니라 **백엔드 자원**이다: 코드당 per-code 큐
 *  + pump 태스크가 붙고(ws.py), 저장셋 밖 코드는 키움 온디맨드 슬롯(실측 여유 162)을
 *  소모한다. 300은 히트맵(235)·관심종목(수십)을 전건 커버하면서 스크리너의 수백~수천
 *  결과가 슬롯을 쓸어가지 않게 막는 선이다. 만석이면 백엔드가 등록을 보류하고
 *  kiwoom_full_house 를 보내며, KiwoomFullHouseToastHost 가 그걸 토스트로 알린다
 *  (2026-07-30 까지 프론트에 이 핸들러가 없어서 만석이 무증상이었다 — 이 주석이
 *  "토스트를 띄운다"고 단정한 채 실제 배선은 없는 상태였다). 보류된 등록은 장부에
 *  남아 슬롯 반환 시 watchdog 이 자동 배정하므로 초과 자체는 graceful 하다.
 *
 *  상한을 넘는 코드는 조용히 폴링만 쓴다 — 등락률이 안 보이는 게 아니라 10초 주기로
 *  보인다. 더 올려야 할 일이 생기면 추정하지 말고 위와 같은 방식으로 실측할 것. */
export const MAX_TICK_SUBSCRIBED_CODES = 300;

/** 한 코드의 최신 체결 표본. price 를 뺀 나머지는 전부 optional —
 *  거래원 REST 합성 틱과 구버전 백엔드엔 해당 키가 없다. */
export interface LiveTickSample {
  /** 마지막 체결가. */
  price: number;
  /** 전일종가 — 키움 FID 11(전일대비)에서 백엔드가 유도해 실어 보낸다. */
  prevClose?: number;
  /** 당일 시가·고가·저가 — 키움 FID 16/17/18. 폴링의 open/high/low 를 대체한다. */
  dayOpen?: number;
  dayHigh?: number;
  dayLow?: number;
}

/** 한 코드의 최신 동시호가 예상체결 표본 (키움 0D FID 23/24).
 *
 *  백엔드가 이미 3중 게이트(venue==KRX AND is_auction_window(프레임 t_ms) AND 값>0,
 *  kiwoom_frames._parse_orderbook)를 걸어 실을지 말지를 결정하므로, 프론트는 시계를
 *  보지 않는다 — 필드가 실려 오면 동시호가고, 안 실려 오면 아니다. 초 단위로
 *  흔들리는 창 경계를 프론트가 두 번째 시계로 추적하지 않기 위한 설계다. */
export interface LiveExpectedSample {
  /** 예상 체결가. */
  price: number;
  /** 예상 체결량. */
  qty: number;
  /** 프레임 자기 시각(거래소 호가시간 유래) — trade 와의 신구 판정용. */
  tMs: number;
  /** 로컬 수신 시각 — TTL 백스톱용(거래정지 등 종료 신호가 안 오는 종목 청소). */
  seenAtMs: number;
}

/** 예상 표본의 신선도 상한. 종료는 보통 데이터 신호(체결 도착·필드 부재 ob)로
 *  오지만, 프레임 자체가 끊긴 종목(거래정지 등)은 이 TTL 이 유일한 청소 경로다.
 *  동시호가 중엔 ob 프레임이 초 단위로 계속 와 seenAtMs 가 갱신되므로 오탐 없음. */
export const EXPECTED_FILL_TTL_MS = 30_000;

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/** 표본이 직전과 완전히 같은지 — 같으면 flush 를 예약하지 않는다.
 *  전 필드를 비교해야 한다: 가격이 그대로여도 고가·저가가 갱신되는 구간이 있고,
 *  그걸 놓치면 화면이 낡은 OHLC 를 계속 보여준다. */
function sameSample(a: LiveTickSample | undefined, b: LiveTickSample): boolean {
  return a !== undefined
    && a.price === b.price
    && a.prevClose === b.prevClose
    && a.dayOpen === b.dayOpen
    && a.dayHigh === b.dayHigh
    && a.dayLow === b.dayLow;
}

/** trade 프레임에서 체결 표본을 꺼낸다. payload 는
 *  {"trades": [{t_ms, price, qty, side, ...}], "prev_close"?, "phase", "venue"}
 *  (kiwoom_frames._parse_trade + stream.on_tick 이 phase/venue 를 덧붙임).
 *  LiveSnapshotEntry 는 per-kind 모델이 의도적으로 미정(types.ts)이라 여기서 좁힌다.
 *
 *  선택 venue 에 속하지 않는 프레임은 등락률에 반영하지 않는다 — 표시 버퍼는 전역·
 *  혼재(전달 무게이트)라 호가·체결 필터와 **같은 정책 SSOT**(`liveVenueAcceptsFrame`)
 *  로 여기서도 게이트한다. 없으면 KRX 선택에도 연장/NXT 시간대 체결이 폴링 baseline
 *  위를 덮어써 관심종목·스크리너·히트맵 등락률이 배제한 시장으로 튄다. */
function tradeSample(entry: LiveSnapshotEntry, venue: LiveVenueOption): LiveTickSample | null {
  if (entry.kind !== 'trade') return null;
  const tMs = (entry as { t_ms?: unknown }).t_ms;
  const tagVenue = (entry as { venue?: 'KRX' | 'NXT' }).venue;
  // t_ms 는 trade 프레임에 항상 실리지만(kiwoom_frames._parse_trade), 없으면 venue
  // 판정이 불가하므로 보수적으로 배제한다 — 소스측 filterTradeByVenue 가 술어를
  // 무조건 거는 것과 정합(느슨한 우회로를 남기지 않는다).
  if (typeof tMs !== 'number' || !liveVenueAcceptsFrame(venue, tagVenue, tMs)) return null;
  const trades = (entry as { trades?: unknown }).trades;
  if (!Array.isArray(trades) || trades.length === 0) return null;
  const price = (trades[trades.length - 1] as { price?: unknown } | undefined)?.price;
  if (typeof price !== 'number' || price <= 0) return null;
  // 종목 단위 값(전일종가·당일 OHLC)은 체결마다 반복되지 않고 payload 최상위에 실린다.
  const e = entry as {
    prev_close?: unknown; day_open?: unknown; day_high?: unknown; day_low?: unknown;
  };
  return {
    price,
    prevClose: positiveNumber(e.prev_close),
    dayOpen: positiveNumber(e.day_open),
    dayHigh: positiveNumber(e.day_high),
    dayLow: positiveNumber(e.day_low),
  };
}

/** ob 프레임의 예상체결 신호. 세 갈래:
 *  - 표본: expected_price/qty 둘 다 >0 (백엔드 게이트를 통과해 실려 온 값)
 *  - 'clear': venue 게이트는 통과했으나 expected 필드 부재 — 백엔드 게이트가 닫혔다는
 *    뜻(동시호가 종료 후 첫 정규장 호가)이므로 남은 표본을 지운다.
 *  - null: venue 불일치·불량 프레임 — 판단 보류(다른 venue 의 호가로 지우지 않는다).
 *  t_ms 부재 시 배제는 tradeSample 과 동일 논리 — venue 판정 불가면 보수적으로 무시. */
function expectedSignal(
  entry: LiveSnapshotEntry,
  venue: LiveVenueOption,
): LiveExpectedSample | 'clear' | null {
  if (entry.kind !== 'ob') return null;
  const tMs = (entry as { t_ms?: unknown }).t_ms;
  const tagVenue = (entry as { venue?: 'KRX' | 'NXT' }).venue;
  if (typeof tMs !== 'number' || !liveVenueAcceptsFrame(venue, tagVenue, tMs)) return null;
  const e = entry as { expected_price?: unknown; expected_qty?: unknown };
  const price = positiveNumber(e.expected_price);
  const qty = positiveNumber(e.expected_qty);
  if (price === undefined || qty === undefined) return 'clear';
  return { price, qty, tMs, seenAtMs: Date.now() };
}

export interface LiveTickOverlayMaps {
  /** 코드→최신 체결 표본. 틱이 아직 없는 코드는 키가 없다. */
  prices: Map<string, LiveTickSample>;
  /** 코드→동시호가 예상체결 표본. 창 밖·체결 도착 후엔 키가 없다. */
  expected: Map<string, LiveExpectedSample>;
}

/** codes 의 최신 체결·예상체결 표본을 WS live 채널에서 구독해 코드→표본 Map 으로
 *  준다. 표본이 아직 없는 코드는 키가 없다(호출부가 폴링값을 그대로 쓰도록). jsdom 등
 *  WebSocket 이 없는 환경에서는 ws.ts 가 silent no-op 이라 빈 Map 이 유지된다.
 *  반환 객체는 렌더마다 새로 만들지만 내부 Map identity 는 flush 때만 바뀐다 —
 *  소비자는 개별 Map 을 deps 로 잡을 것. */
export function useLiveTickPrices(
  codes: string[],
  venue: LiveVenueOption,
): LiveTickOverlayMaps {
  // 구독 집합은 정렬·dedup 한 문자열 키에서 파생해, 리스트 재정렬이나 매 렌더의
  // 새 배열 identity 가 전 종목 재구독(unsubscribe → subscribe 왕복)을 부르지
  // 않게 한다 — liveQuotes.ts 의 queryKey 정렬과 같은 이유.
  const codesKey = useMemo(() => [...new Set(codes)].sort().join(','), [codes]);
  const subscribed = useMemo(
    () => (codesKey === '' ? [] : codesKey.split(',').slice(0, MAX_TICK_SUBSCRIBED_CODES)),
    [codesKey],
  );

  // 두 Map 을 분리한다. accum 은 틱이 올 때마다 제자리 갱신되는 누적본이고,
  // snapshot 은 스로틀 창마다 새로 복사돼 identity 가 바뀌는 렌더용이다 —
  // 호출부 useMemo 가 이 Map 을 deps 로 잡으므로 ref 제자리 변경만으로는
  // 재계산이 걸리지 않는다. 하나로 합치면 "이미 반영된 값" 판정이 스냅샷 기준이
  // 돼 같은 가격에 flush 가 중복 예약된다.
  const accumRef = useRef(new Map<string, LiveTickSample>());
  const snapshotRef = useRef(new Map<string, LiveTickSample>());
  const expectedAccumRef = useRef(new Map<string, LiveExpectedSample>());
  const expectedSnapshotRef = useRef(new Map<string, LiveExpectedSample>());
  const [, setTick] = useState(0);

  useEffect(() => {
    if (subscribed.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      snapshotRef.current = new Map(accumRef.current);
      expectedSnapshotRef.current = new Map(expectedAccumRef.current);
      setTick((t) => t + 1);
    };
    const scheduleFlush = () => {
      if (timer === null) timer = setTimeout(flush, LIVE_FLUSH_MS);
    };
    const unsubs = subscribed.map((code) =>
      subscribeLive(code, (entry: LiveSnapshotEntry) => {
        if (entry.kind === 'ob') {
          const signal = expectedSignal(entry, venue);
          if (signal === null) return;
          if (signal === 'clear') {
            if (expectedAccumRef.current.delete(code)) scheduleFlush();
            return;
          }
          // 값이 직전과 같아도 매번 set + flush 한다 — seenAtMs 갱신이 곧 "아직
          // 동시호가 진행 중" 신호라서다. 값 비교로 건너뛰면 예상가가 안 움직이는
          // 저유동 종목에서 seenAtMs 가 얼어 TTL 백스톱이 진행 중인 창을 오탐
          // 청소한다. 재렌더 비용은 LIVE_FLUSH_MS 코얼레싱이 이미 상한을 친다.
          expectedAccumRef.current.set(code, signal);
          scheduleFlush();
          return;
        }
        const sample = tradeSample(entry, venue);
        if (sample === null) return;
        // venue 게이트를 통과한 체결 = 단일가가 맺혔다는 뜻 — 예상 표본을 폐기한다
        // (데이터 주도 전환의 종료 신호 ①). sameSample 로 표본 갱신을 건너뛰는
        // 경우에도 폐기는 수행해야 하므로 dedup 앞에 둔다.
        //
        // 단 **거래소 시각을 비교**해야 한다. 마감 동시호가(15:20~)는 연속장에서
        // 곧바로 이어지므로 15:19:59 에 맺힌 체결 프레임이 첫 예상 프레임(15:20:00+)
        // 보다 늦게 도착할 수 있다. 무조건 폐기하면 그 오래된 체결이 더 새로운
        // 예상값을 죽여 표시가 한 프레임 깜빡인다(개장 동시호가엔 직전 체결이
        // 20분 이상 없어 이 경합 자체가 없다 — 오후 전용 경계 조건).
        // >= 인 이유: 15:30 마감 크로스 체결은 마지막 예상 프레임과 같은 초이거나
        // 그 이후라, 정상 종료 신호로서 반드시 폐기되어야 한다.
        const tradeTMs = (entry as { t_ms?: unknown }).t_ms; // tradeSample 이 number 검증
        const pending = expectedAccumRef.current.get(code);
        if (pending !== undefined && typeof tradeTMs === 'number' && tradeTMs >= pending.tMs) {
          expectedAccumRef.current.delete(code);
          scheduleFlush();
        }
        // 같은 값 재체결은 재렌더를 만들 이유가 없다(호가만 흔들리는 구간에서
        // 흔하다). 스로틀 앞단에서 걸러 flush 자체를 아낀다. prevClose 도 비교에
        // 넣는 건 첫 프레임에서 뒤늦게 채워지는 경우를 놓치지 않기 위해서다.
        if (sameSample(accumRef.current.get(code), sample)) return;
        accumRef.current.set(code, sample);
        scheduleFlush();
      }),
    );
    return () => {
      for (const unsub of unsubs) unsub();
      if (timer !== null) clearTimeout(timer);
      // 구독 집합이 바뀌면 이전 코드의 체결가는 남기지 않는다 — 폴링값으로
      // 되돌아가는 게 옛 틱을 계속 보여주는 것보다 정직하다.
      accumRef.current = new Map();
      snapshotRef.current = new Map();
      expectedAccumRef.current = new Map();
      expectedSnapshotRef.current = new Map();
    };
    // venue 를 deps 에 넣어 토글 시 재구독하며 accum 을 리셋한다 — 이전 venue 로
    // 누적된 off-venue 체결가가 새 선택에 남지 않는다.
  }, [subscribed, venue]);

  return { prices: snapshotRef.current, expected: expectedSnapshotRef.current };
}

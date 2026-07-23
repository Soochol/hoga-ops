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
 *  결과가 슬롯을 쓸어가지 않게 막는 선이다. 만석이면 백엔드가 거부하고
 *  kiwoom_full_house 토스트를 띄우므로 초과 자체는 graceful 하다.
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

/** codes 의 최신 체결 표본을 WS live 채널에서 구독해 코드→표본 Map 으로 준다.
 *  틱이 아직 없는 코드는 키가 없다(호출부가 폴링값을 그대로 쓰도록). jsdom 등
 *  WebSocket 이 없는 환경에서는 ws.ts 가 silent no-op 이라 빈 Map 이 유지된다. */
export function useLiveTickPrices(
  codes: string[],
  venue: LiveVenueOption,
): Map<string, LiveTickSample> {
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
  const [, setTick] = useState(0);

  useEffect(() => {
    if (subscribed.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      snapshotRef.current = new Map(accumRef.current);
      setTick((t) => t + 1);
    };
    const unsubs = subscribed.map((code) =>
      subscribeLive(code, (entry: LiveSnapshotEntry) => {
        const sample = tradeSample(entry, venue);
        if (sample === null) return;
        // 같은 값 재체결은 재렌더를 만들 이유가 없다(호가만 흔들리는 구간에서
        // 흔하다). 스로틀 앞단에서 걸러 flush 자체를 아낀다. prevClose 도 비교에
        // 넣는 건 첫 프레임에서 뒤늦게 채워지는 경우를 놓치지 않기 위해서다.
        if (sameSample(accumRef.current.get(code), sample)) return;
        accumRef.current.set(code, sample);
        if (timer === null) timer = setTimeout(flush, LIVE_FLUSH_MS);
      }),
    );
    return () => {
      for (const unsub of unsubs) unsub();
      if (timer !== null) clearTimeout(timer);
      // 구독 집합이 바뀌면 이전 코드의 체결가는 남기지 않는다 — 폴링값으로
      // 되돌아가는 게 옛 틱을 계속 보여주는 것보다 정직하다.
      accumRef.current = new Map();
      snapshotRef.current = new Map();
    };
    // venue 를 deps 에 넣어 토글 시 재구독하며 accum 을 리셋한다 — 이전 venue 로
    // 누적된 off-venue 체결가가 새 선택에 남지 않는다.
  }, [subscribed, venue]);

  return snapshotRef.current;
}

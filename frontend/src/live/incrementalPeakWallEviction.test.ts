/**
 * 슬라이딩 축출 하의 **오라클 파리티** — 트랙 1-3 의 핵심 가드.
 *
 * 증분 소스의 계약은 단 하나다: **"같은 결과를 덜 계산한다".** 그래서 속도가 아니라
 * 결과를 잰다 — 매 스텝마다 같은 배열을 **새 인스턴스**에 먹여 얻은 결과(그 인스턴스는
 * 전량 재소비 경로를 타고, 그 경로가 배치 `toWallEventsFromOrderbooks + classify` 와
 * 동일함은 소스 머리말이 보증한다)와 전수 비교한다.
 *
 * 왜 이 파일이 따로 있나: 종전 `useDayPeaks.perf.test.tsx` 는 배열이 **append-only** 이거나
 * **통째로 교체**되는 두 모양만 봤다. 라이브 버퍼의 세 번째 모양 — **앞을 자르고 뒤에
 * 붙이는** 15분 슬라이딩 — 을 아무 테스트도 안 봤고, 그게 결함이 숨은 이유였다.
 *
 * 난수는 **고정 시드 LCG** 다. 이 리포는 비결정적 테스트를 기각했다(#434/#516/#977) —
 * 실패가 재현되지 않으면 가드가 아니라 소음이다.
 */
import { describe, it, expect, vi } from 'vitest';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
import * as bucketHogaSeries from './bucketHogaSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { AskPeakCandidate } from '../api/types';

const base = Date.UTC(2026, 5, 23, 0, 0, 0);
const OPEN_MS = base;

/** 고정 시드 선형 합동 난수 — 실패가 항상 같은 입력에서 난다. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function mkOb(i: number, rnd: () => number): ObSnapshot {
  return {
    t_ms: base + i * 1000,
    total_ask_qty: 1000 + i,
    total_bid_qty: 900 + i,
    // 10레벨 연속북 → isIndicatorEligibleBook 통과. qty 를 흔들어 max-qty 갱신 경로도 탄다.
    asks: Array.from({ length: 10 }, (_u, l) => ({
      price: 40_000 + l, qty: 1 + Math.floor(rnd() * 500),
    })),
    bids: Array.from({ length: 10 }, (_u, l) => ({
      price: 39_990 + l, qty: 1 + Math.floor(rnd() * 500),
    })),
  };
}

function mkTrade(i: number, rnd: () => number): TradeSnapshot {
  const n = 1 + Math.floor(rnd() * 3);
  return {
    t_ms: base + i * 1000,
    trades: Array.from({ length: n }, () => ({
      side: rnd() < 0.5 ? 1 : -1,
      price: 39_990 + Math.floor(rnd() * 20),
      qty: 1,
    })),
  };
}

/**
 * 창 안의 실제 벽 하나를 **그대로 복사한** extra. 이게 이 파일의 가장 미묘한 축이다.
 *
 * extras 는 백엔드 seed(오늘의 벽 후보)라 **과거 시점을 가리킬 수 있고**, 그 시점이
 * 창 밖으로 밀려나면 상태가 갈린다:
 *   - 누적 이벤트가 아직 창에 있으면 → 같은 후보이므로 **건너뛴다**(dedup).
 *   - 축출됐으면 → 오라클(새 인스턴스)엔 그 이벤트가 없으므로 extra 를 **고려한다**.
 * 즉 `eventIndexByKey` 조회가 head 아래 죽은 슬롯을 살아 있다고 읽으면 extra 를 잘못
 * 건너뛰어 결과가 갈린다. dedup 은 `price:t_ms` 키 + **qty 완전 일치**로만 걸리므로,
 * 무작위 extra 로는 이 경로가 사실상 열리지 않는다 — 실제 벽을 복사해야 열린다.
 */
function extraFromWall(snapshot: ObSnapshot, side: Side): AskPeakCandidate | null {
  const levels = side === 'ask' ? snapshot.asks : snapshot.bids;
  if (!levels || levels.length === 0) return null;
  const level = levels[0];
  return { price: level.price, qty: level.qty, t_ms: snapshot.t_ms };
}

type Side = 'ask' | 'bid';

/** 증분 소스를 슬라이딩으로 굴리며 매 스텝 오라클과 대조. */
function runParity(side: Side, seed: number, steps: number, asOf: boolean): void {
  const rnd = lcg(seed);
  const src = new IncrementalPeakWallSource(side);
  let ob: ObSnapshot[] = Array.from({ length: 40 }, (_u, i) => mkOb(i, rnd));
  let trade: TradeSnapshot[] = Array.from({ length: 40 }, (_u, i) => mkTrade(i, rnd));
  let next = 40;
  let rememberedWall: AskPeakCandidate | null = null;

  for (let step = 0; step < steps; step += 1) {
    // 앞에서 0~2개 축출, 뒤에 1~3개 append — 실제 슬라이딩 버퍼의 모양.
    const evictOb = Math.floor(rnd() * 3);
    const evictTr = Math.floor(rnd() * 3);
    const addOb = 1 + Math.floor(rnd() * 3);
    const addTr = 1 + Math.floor(rnd() * 3);
    const appendedOb = Array.from({ length: addOb }, () => mkOb(next++, rnd));
    const appendedTr = Array.from({ length: addTr }, (_u, k) => mkTrade(next + k, rnd));
    ob = [...ob.slice(evictOb), ...appendedOb];
    trade = [...trade.slice(evictTr), ...appendedTr];

    // 오래된 벽을 기억해 두고 **축출된 뒤에도** extras 로 계속 넣는다 — 위 함수 주석의
    // 경로를 실제로 열기 위해서다. 창 안일 때와 밖일 때 기대 동작이 반대라 강한 대조다.
    if (rememberedWall === null || rnd() < 0.1) {
      rememberedWall = extraFromWall(ob[0], side);
    }
    const extras: AskPeakCandidate[] = rememberedWall ? [rememberedWall] : [];
    const cutoff = ob[Math.floor(rnd() * ob.length)].t_ms;

    const actual = asOf
      ? src.updateAsOf(ob, trade, extras, cutoff, OPEN_MS)
      : src.update(ob, trade, OPEN_MS, extras);
    // 오라클: 같은 입력을 **처음 보는** 인스턴스에 먹인다 → 전량 재소비 경로.
    const oracle = new IncrementalPeakWallSource(side);
    const expected = asOf
      ? oracle.updateAsOf(ob, trade, extras, cutoff, OPEN_MS)
      : oracle.update(ob, trade, OPEN_MS, extras);

    expect({ step, ...actual }).toEqual({ step, ...expected });
  }
}

describe('IncrementalPeakWallSource — 슬라이딩 축출 파리티', () => {
  for (const side of ['ask', 'bid'] as const) {
    it(`${side}: 200스텝 슬라이딩에서 오라클과 항상 같다`, () => {
      runParity(side, 0x5eed_1234, 200, false);
    });
    it(`${side}: cutoff 경로(updateAsOf)도 200스텝 동안 같다`, () => {
      // 팬 중에는 이 경로가 돈다. 축출 정확성은 여기서도 성립해야 하는데 다른 어떤
      // 테스트도 「축출 × cutoff」 조합을 보지 않는다.
      runParity(side, 0xc0ff_ee01, 200, true);
    });
  }

  it('여러 시드에서도 성립한다', () => {
    for (const seed of [1, 2, 7, 42, 999, 123_457]) runParity('ask', seed, 60, false);
  });
});

describe('축출 폴백 — 한 번에 한 변수씩', () => {
  it('t_ms 중복이 생기면 전량 재소비로 떨어진다(결과는 그대로 옳다)', () => {
    const rnd = lcg(7);
    const src = new IncrementalPeakWallSource('ask');
    const ob = Array.from({ length: 30 }, (_u, i) => mkOb(i, rnd));
    // 같은 t_ms 를 가진 스냅샷을 하나 더 끼운다 → `price:t_ms` 키가 두 스냅샷에서 나온다.
    const twin: ObSnapshot = { ...ob[10], asks: (ob[10].asks ?? []).map((l) => ({ ...l, qty: l.qty + 1 })) };
    const withTwin = [...ob.slice(0, 11), twin, ...ob.slice(11)];
    src.update(withTwin, [], OPEN_MS, []);

    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    const tail = mkOb(100, rnd);
    const slid = [...withTwin.slice(2), tail];
    const actual = src.update(slid, [], OPEN_MS, []);
    // 폴백이 걸렸으므로 전량(=slid.length)을 다시 소비한다.
    expect(spy.mock.calls.length).toBe(slid.length);
    spy.mockRestore();
    // 그리고 결과는 여전히 오라클과 같다 — 폴백이 정확성을 보증한다는 계약.
    expect(actual).toEqual(new IncrementalPeakWallSource('ask').update(slid, [], OPEN_MS, []));
  });

  it('터치가 시간 역순으로 오면 전량 재소비로 떨어진다(결과는 그대로 옳다)', () => {
    const rnd = lcg(11);
    const src = new IncrementalPeakWallSource('ask');
    const ob = Array.from({ length: 30 }, (_u, i) => mkOb(i, rnd));
    const trade = Array.from({ length: 30 }, (_u, i) => mkTrade(i, rnd));
    // 한 아이템만 과거 시각으로 — `touchOrderCompromised` 가 서는 유일한 조건.
    trade[20] = { t_ms: trade[20].t_ms, trades: [{ side: 1, price: 40_001, qty: 1, t_ms: base + 1000 }] };
    src.update(ob, trade, OPEN_MS, []);

    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    const slid = [...ob.slice(2), mkOb(100, rnd)];
    const slidTr = [...trade.slice(2), mkTrade(100, rnd)];
    const actual = src.update(slid, slidTr, OPEN_MS, []);
    expect(spy.mock.calls.length).toBe(slid.length);
    spy.mockRestore();
    expect(actual).toEqual(new IncrementalPeakWallSource('ask').update(slid, slidTr, OPEN_MS, []));
  });

  it('sessionOpenMs 가 바뀌면 축출과 무관하게 리셋된다(기존 계약 고정)', () => {
    const rnd = lcg(13);
    const src = new IncrementalPeakWallSource('ask');
    const ob = Array.from({ length: 20 }, (_u, i) => mkOb(i, rnd));
    src.update(ob, [], OPEN_MS, []);
    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    src.update(ob, [], OPEN_MS - 3_600_000, []);
    expect(spy.mock.calls.length).toBe(ob.length);
    spy.mockRestore();
  });

  it('버퍼가 통째로 바뀌면(종목 전환) 전량 재소비 — 기존 안전망 유지', () => {
    const rnd = lcg(17);
    const src = new IncrementalPeakWallSource('ask');
    src.update(Array.from({ length: 20 }, (_u, i) => mkOb(i, rnd)), [], OPEN_MS, []);
    const spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    const other = Array.from({ length: 20 }, (_u, i) => mkOb(i + 500, rnd));
    src.update(other, [], OPEN_MS, []);
    expect(spy.mock.calls.length).toBe(other.length);
    spy.mockRestore();
  });
});

describe('메모리 상한 — 축출이 실제로 버린다', () => {
  it('오래 굴려도 누적 이벤트가 창 크기에 머문다', () => {
    const rnd = lcg(0xabc);
    const src = new IncrementalPeakWallSource('ask');
    const WINDOW = 50;
    let ob: ObSnapshot[] = Array.from({ length: WINDOW }, (_u, i) => mkOb(i, rnd));
    src.update(ob, [], OPEN_MS, []);
    for (let step = 0; step < 400; step += 1) {
      ob = [...ob.slice(1), mkOb(WINDOW + step, rnd)];
      src.update(ob, [], OPEN_MS, []);
    }
    // 내부 상태를 직접 본다 — 이 성질은 공개 API 로 관측되지 않는데, 없으면 세션이
    // 길어질수록 classify 가 느려지고 힙이 는다(그게 이 수정의 절반이다).
    const internal = src as unknown as { events: unknown[]; head: number };
    const live = internal.events.length - internal.head;
    // 창 50개 × 10레벨 = 500 이 상한. head 압축 지연으로 배열 자체는 그보다 클 수 있으나
    // 무한히 자라면 안 된다.
    expect(live).toBeLessThanOrEqual(500);
    expect(internal.events.length).toBeLessThanOrEqual(1000);
  });
});

describe('축출된 슬롯의 재사용 — consumeOb 의 head 검사', () => {
  /**
   * 축출된 이벤트의 키를 **새 스냅샷이 다시 쓰는** 경우.
   *
   * 정상 데이터(t_ms 단조 증가)에서는 일어나지 않는다 — 축출된 t_ms 는 다시 오지 않는다.
   * 그래서 이 검사는 **방어적**이지만, 벤더 프레임이 시각을 되감으면(재연결 후 백필,
   * 시계 보정) 도달 가능하고 그때 조용히 이벤트를 잃는다: head 아래 죽은 슬롯에 쓰면
   * 그 이벤트는 순회 대상이 아니라 **영영 결과에 안 나온다**.
   *
   * 여기서는 그 상황을 직접 만들어 가드가 짐을 지게 한다.
   */
  it('축출된 키를 새 스냅샷이 다시 써도 이벤트를 잃지 않는다', () => {
    const rnd = lcg(23);
    const src = new IncrementalPeakWallSource('ask');
    const ob = Array.from({ length: 20 }, (_u, i) => mkOb(i, rnd));
    src.update(ob, [], OPEN_MS, []);

    // 앞 3개를 축출 → head 가 올라가고, 그 키들이 맵에 죽은 채로 남는다(압축 전).
    const slid = ob.slice(3);
    src.update(slid, [], OPEN_MS, []);

    // 축출된 스냅샷과 **같은 t_ms·같은 price** 를 가진 프레임이 뒤늦게 도착한다.
    const revenant: ObSnapshot = {
      ...ob[0],
      asks: (ob[0].asks ?? []).map((l, i) => ({ price: l.price, qty: i === 0 ? 987_654 : l.qty })),
    };
    const withRevenant = [...slid, revenant];
    const actual = src.update(withRevenant, [], OPEN_MS, []);
    const oracle = new IncrementalPeakWallSource('ask').update(withRevenant, [], OPEN_MS, []);

    expect(actual).toEqual(oracle);
    // 그 벽이 압도적으로 크므로 결과 최상단이어야 한다 — 잃었으면 여기서 드러난다.
    expect(actual.all[0].qty).toBe(987_654);
  });
});

describe('폴백은 영구가 아니다 — 자가 복구', () => {
  /**
   * 폴백 플래그의 수명이 **세션이 아니라 누적 상태**임을 값으로 못박는다.
   *
   * 왜 중요한가: 실데이터가 t_ms 중복을 한 번 만들었다고 그 창이 남은 장중 내내 전량
   * 재소비로 도는 것과, 충돌 쌍이 창을 벗어나면 슬라이딩이 재개되는 것은 **비용이 하늘과
   * 땅 차이**다. 필드 주석이 "sticky" 라고만 하면 전자로 읽히므로 여기서 구별한다.
   */
  it('충돌 쌍이 창을 벗어나면 슬라이딩이 재개된다', () => {
    const rnd = lcg(31);
    const src = new IncrementalPeakWallSource('ask');
    const head = Array.from({ length: 6 }, (_u, i) => mkOb(i, rnd));
    const twin: ObSnapshot = { ...head[2], asks: (head[2].asks ?? []).map((l) => ({ ...l, qty: l.qty + 7 })) };
    // 충돌 쌍(head[2] · twin)이 앞쪽에 있는 창.
    let win = [...head.slice(0, 3), twin, ...head.slice(3)];
    const tail = Array.from({ length: 12 }, (_u, i) => mkOb(100 + i, rnd));
    src.update(win, [], OPEN_MS, []);

    // 충돌 쌍이 아직 창에 있는 동안: 축출하면 전량 재소비.
    win = [...win.slice(1), tail[0]];
    let spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    src.update(win, [], OPEN_MS, []);
    expect(spy.mock.calls.length).toBe(win.length);
    spy.mockRestore();

    // 쌍이 창 밖으로 나갈 때까지 민다.
    for (let i = 1; i < 8; i += 1) {
      win = [...win.slice(1), tail[i]];
      src.update(win, [], OPEN_MS, []);
    }
    // 이제 슬라이딩이 재개돼야 한다 — 붙인 1개만 소비.
    win = [...win.slice(1), tail[8]];
    spy = vi.spyOn(bucketHogaSeries, 'isIndicatorEligibleBook');
    src.update(win, [], OPEN_MS, []);
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
  });

  it('진단 카운터가 폴백을 센다 — 장중에 최적화가 살아 있는지 보는 유일한 창구', () => {
    const rnd = lcg(37);
    const src = new IncrementalPeakWallSource('ask');
    const ob = Array.from({ length: 10 }, (_u, i) => mkOb(i, rnd));
    src.update(ob, [], OPEN_MS, []);
    // 첫 소비는 폴백이 아니다.
    expect(src.diagnostics().fallbacks).toBe(0);

    // 버퍼 통째 교체 → 폴백 1회, 사유 기록.
    src.update(Array.from({ length: 10 }, (_u, i) => mkOb(i + 900, rnd)), [], OPEN_MS, []);
    expect(src.diagnostics().fallbacks).toBe(1);
    expect(src.diagnostics().lastFallbackReason).toBe('buffer-replaced');

    // 슬라이딩은 카운터를 올리지 않는다.
    const before = src.diagnostics().fallbacks;
    const win = Array.from({ length: 10 }, (_u, i) => mkOb(i + 900, rnd));
    src.update(win, [], OPEN_MS, []);              // 또 교체(+1)
    const w2 = [...win.slice(1), mkOb(2000, rnd)]; // 슬라이딩(+0)
    src.update(w2, [], OPEN_MS, []);
    expect(src.diagnostics().fallbacks).toBe(before + 1);
    // 축출이 실제로 일어났으므로 살아 있는 이벤트는 창 크기에 머문다.
    expect(src.diagnostics().liveEvents).toBeLessThanOrEqual(10 * 10);
  });
});

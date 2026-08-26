import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDayAskPeaks, deriveDayAskPeaksIncremental } from './useDayAskPeaks';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
import { classifyAskWallEvents, toWallEventsFromOrderbooks } from './peakWallEventClassifier';
import type { AskPeak } from '../api/types';
import type { LiveTodayAskPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const deep = (t_ms: number, q: number, price = 26000): ObSnapshot => ({
  t_ms, total_ask_qty: 0, total_bid_qty: 0,
  asks: [{ price, qty: q }, ...Array.from({ length: 9 }, () => ({ price: 1, qty: 1 }))],
  bids: Array.from({ length: 10 }, (_, i) => ({ price: 24000 - i, qty: 100 })),
});

const byDate = (peaks: readonly AskPeak[]) => {
  const out: Record<string, AskPeak> = {};
  for (const peak of peaks) {
    const current = out[peak.date];
    const peakQty = peak.qty ?? Number.NEGATIVE_INFINITY;
    const currentQty = current?.qty ?? Number.NEGATIVE_INFINITY;
    if (!current || peakQty > currentQty) out[peak.date] = peak;
  }
  return out;
};
const atKst = (hh: number, mm = 0) => Date.UTC(2026, 5, 13, hh - 9, mm);
// 개장 하한(09:00 KST) — 필수 인자화 경위는 computeDayAskPeak.test 의 같은 상수 참조.
const OPEN_MS = atKst(9);

const todayAskPeak = (overrides: Partial<LiveTodayAskPeak> = {}): LiveTodayAskPeak => ({
  date: '20260613',
  coverage: 'partial',
  traded_price: 25500,
  traded_qty: 9000,
  traded_t_ms: atKst(9, 10),
  all_price: 26000,
  all_qty: 12000,
  all_t_ms: atKst(9, 11),
  ...overrides,
});

const trade = (
  t_ms: number,
  trades: TradeSnapshot['trades'],
): TradeSnapshot => ({ t_ms, trades });

describe('useDayAskPeaks', () => {
  it('과거일 seed는 그대로 통과, 오늘 기준선은 체결된 가격의 live.ob로 ratchet', () => {
    const seeds: AskPeak[] = [
      { date: '20260611', price: 297000, qty: 32621, t_ms: 1,
        max_price: 300000, max_qty: 40000, max_t_ms: 11 },
      { date: '20260613', price: 25100, qty: 5000, t_ms: 2,
        max_price: 25100, max_qty: 5000, max_t_ms: 2 },
    ];
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, seeds, '20260613', OPEN_MS, '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );
    let m = byDate(result.current);
    expect(m['20260611'].qty).toBe(32621); // 과거일 그대로
    expect(m['20260613']).toBeUndefined(); // 오늘 seed는 체결가격 기준선으로 쓰지 않음

    const t = atKst(9, 20);
    rerender({
      ob: [deep(t, 9000)],
      trades: [trade(t + 1_000, [{ t_ms: t + 1_000, side: 1, price: 26000, qty: 10 }])],
    });
    m = byDate(result.current);
    expect(m['20260611'].qty).toBe(32621); // 과거일 불변
    expect(m['20260613'].qty).toBe(9000); // 오늘 체결가격 기준 ratchet 전진
    expect(m['20260613'].date).toBe('20260613');
    expect(m['20260611'].max_qty).toBe(40000); // 과거일 seed의 max_* 그대로 통과
  });

  it('오늘 seed 없어도 체결된 가격의 live.ob 신기록이면 오늘 항목 생성', () => {
    const seeds: AskPeak[] = [
      { date: '20260611', price: 297000, qty: 32621, t_ms: 1,
        max_price: 300000, max_qty: 40000, max_t_ms: 11 },
    ];
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, seeds, '20260613', OPEN_MS, '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );
    expect(result.current.find((p) => p.date === '20260613')).toBeUndefined();
    const t = atKst(9, 20);
    rerender({
      ob: [deep(t, 7000)],
      trades: [trade(t + 1_000, [{ t_ms: t + 1_000, side: -1, price: 26000, qty: 10 }])],
    });
    expect(result.current.find((p) => p.date === '20260613')?.qty).toBe(7000);
  });

  it('오늘 entry는 close triple과 max triple이 동일(ratchet 동일값 — 토글 무효)', () => {
    const seeds: AskPeak[] = [
      { date: '20260613', price: 25100, qty: 5000, t_ms: 2,
        max_price: 25100, max_qty: 5000, max_t_ms: 2 },
    ];
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, seeds, '20260613', OPEN_MS, '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );
    const t = atKst(9, 20);
    rerender({
      ob: [deep(t, 9000, 26500)],
      trades: [trade(t + 1_000, [{ t_ms: t + 1_000, side: 1, price: 26500, qty: 10 }])],
    });
    const today = byDate(result.current)['20260613'];
    expect(today.qty).toBe(9000);
    expect(today.max_qty).toBe(today.qty);
    expect(today.max_price).toBe(today.price);
    expect(today.max_t_ms).toBe(today.t_ms);
  });

  it('backend today payload가 있으면 traded triple로 오늘 기준선을 만들고 과거 seed는 보존', () => {
    const seeds: AskPeak[] = [
      { date: '20260611', price: 297000, qty: 32621, t_ms: 1,
        max_price: 300000, max_qty: 40000, max_t_ms: 11 },
      { date: '20260613', price: 25100, qty: 5000, t_ms: 2,
        max_price: 25100, max_qty: 5000, max_t_ms: 2 },
    ];
    const restPeak = todayAskPeak({
      traded_t_ms: 3,
      all_t_ms: 4,
    });

    // ⚠ 하한이 0 인 이유: 이 케이스는 t_ms 를 **작은 정수**(3·4·5)로 쓴다. 종전에 이게
    // 통과한 건 우연이었다 — epoch 0 이 곧 1970-01-01 **09:00 KST** 라, 09:00 고정 하한이
    // `kstMinuteOfDay(5) === 540` 로 만족돼 버렸다. 하한이 인자가 된 지금 2026년 09:00 을
    // 넘기면 이 스냅샷들은 정당하게 배제된다. 시각 체계를 바꾸는 대신 이 테스트가 재는
    // 것(백엔드 payload → traded triple 조립)에 맞춰 하한을 열어 둔다.
    const { result } = renderHook(
      () => useDayAskPeaks([deep(5, 15000)], [], seeds, '20260613', 0, '005930', restPeak),
    );

    const m = byDate(result.current);
    expect(m['20260611']).toEqual(seeds[0]);
    expect(m['20260613']).toMatchObject({
      date: '20260613',
      price: 25500,
      qty: 9000,
      t_ms: 3,
      max_price: 25500,
      max_qty: 9000,
      max_t_ms: 3,
    });
  });

  it('backend today payload의 traded_peaks를 체결가격 기준 후보 목록으로 보존한다', () => {
    const restPeak = todayAskPeak({
      traded_peaks: [
        { price: 25500, qty: 9000, t_ms: 3 },
        { price: 25600, qty: 8000, t_ms: 4 },
        { price: 25700, qty: 7000, t_ms: 5 },
      ],
    });

    const { result } = renderHook(
      () => useDayAskPeaks([], [], [], '20260613', OPEN_MS, '005930', restPeak),
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      date: '20260613',
      price: 25500,
      qty: 9000,
      t_ms: 3,
      traded_peaks: [
        { price: 25500, qty: 9000, t_ms: 3 },
        { price: 25600, qty: 8000, t_ms: 4 },
        { price: 25700, qty: 7000, t_ms: 5 },
      ],
    });
  });

  it('judges same-price ask walls on their own minute (ADR-0156)', () => {
    // 09:10 벽에는 같은 분(09:10:30) 체결이 있고, 09:12 의 **더 큰** 벽에는 없다.
    // 옛 규칙이었다면 09:10:30 체결이 이후 내내 유효해 09:12 벽도 체결이었다.
    const { result } = renderHook(() => useDayAskPeaks(
      [
        deep(atKst(9, 10), 1200, 26000),
        deep(atKst(9, 12), 9000, 26000),
      ],
      [trade(atKst(9, 10) + 30_000, [
        { t_ms: atKst(9, 10) + 30_000, side: 1, price: 26000, qty: 10 },
      ])],
      [],
      '20260613',
      OPEN_MS,
      '005930',
    ));

    const today = byDate(result.current)['20260613'];
    expect(today).toMatchObject({
      date: '20260613',
      price: 26000,
      qty: 1200,
      t_ms: atKst(9, 10),
    });
    // `deep()` 픽스처의 채움 레벨(price 1)도 체결가에 지배되므로 포함/제외로 단언한다.
    expect(today.traded_peaks).toContainEqual({ price: 26000, qty: 1200, t_ms: atKst(9, 10) });
    expect(today.traded_peaks).not.toContainEqual({ price: 26000, qty: 9000, t_ms: atKst(9, 12) });
    // 터치와 무관한 all 계열에는 더 큰 09:12 벽이 1위로 남는다.
    expect(today.all_peaks?.slice(0, 2)).toEqual([
      { price: 26000, qty: 9000, t_ms: atKst(9, 12) },
      { price: 26000, qty: 1200, t_ms: atKst(9, 10) },
    ]);
  });

  it('backend today payload에 traded peak가 없으면 오늘 체결 기준선을 만들지 않는다(행은 전체 벽 패밀리로만 남는다)', () => {
    const restPeak = todayAskPeak({
      traded_price: null,
      traded_qty: null,
      traded_t_ms: null,
      all_t_ms: 4,
    });

    const { result } = renderHook(
      () => useDayAskPeaks([deep(5, 15000)], [], [], '20260613', OPEN_MS, '005930', restPeak),
    );

    // 체결된 벽 carrier 는 비어 그 선은 오늘을 건너뛰지만, 전체 최대벽 선(터치 무관)의
    // 원천인 all 패밀리가 있으므로 행 자체는 남는다.
    const today = result.current.find((p) => p.date === '20260613');
    expect(today).toMatchObject({ price: null, qty: null, t_ms: null });
    expect(today?.traded_peaks).toEqual([]);
    expect(today?.all_peaks?.length).toBeGreaterThan(0);
  });

  it('REST today seed keeps updating traded baseline from later trade prices and OB walls', () => {
    const restPeak = todayAskPeak();
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, [], '20260613', OPEN_MS, '005930', restPeak),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    expect(byDate(result.current)['20260613']?.qty).toBe(9000);

    // 체결과 벽을 **같은 분**(09:19)에 둔다 — ADR-0156 이후 다른 분이면 승격되지 않는다.
    rerender({
      trades: [trade(atKst(9, 19) + 30_000, [
        { t_ms: atKst(9, 19) + 30_000, side: 1, price: 27000, qty: 10 },
      ])],
      ob: [deep(atKst(9, 19), 20000, 27000)],
    });

    const today = byDate(result.current)['20260613'];
    expect(today).toMatchObject({
      price: 27000,
      qty: 20000,
      t_ms: atKst(9, 19),
      max_price: 27000,
      max_qty: 20000,
      max_t_ms: atKst(9, 19),
    });
  });

  it('promotes an already-seen wall when a later trade lands in the same minute', () => {
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, [], '20260613', OPEN_MS, '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    rerender({
      trades: [],
      ob: [deep(atKst(9, 20), 20000, 27000)],
    });
    // 터치 전: 체결 기준선 carrier 는 비어 있고 all 패밀리만 벽을 든다.
    const untouched = result.current.find((p) => p.date === '20260613');
    expect(untouched?.price).toBeNull();
    expect(untouched?.all_peaks).toContainEqual({ price: 27000, qty: 20000, t_ms: atKst(9, 20) });

    rerender({
      trades: [trade(atKst(9, 20) + 40_000, [
        { t_ms: atKst(9, 20) + 40_000, side: 1, price: 27000, qty: 10 },
      ])],
      ob: [deep(atKst(9, 20), 20000, 27000)],
    });

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 27000,
      qty: 20000,
      t_ms: atKst(9, 20),
    });
  });

  it('ignores trade events without numeric prices when updating traded baseline', () => {
    const restPeak = todayAskPeak();
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, [], '20260613', OPEN_MS, '005930', restPeak),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    rerender({
      trades: [trade(atKst(9, 20), [{ t_ms: atKst(9, 20), side: 1, qty: 10 }])],
      ob: [deep(atKst(9, 21), 20000, 27000)],
    });

    expect(byDate(result.current)['20260613']?.qty).toBe(9000);
  });

  it('same-second trade snapshots all contribute prices to traded baseline', () => {
    const restPeak = todayAskPeak();
    const sameSecond = atKst(9, 20);
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, [], '20260613', OPEN_MS, '005930', restPeak),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    rerender({
      trades: [
        trade(sameSecond, [{ t_ms: sameSecond, side: 1, price: 26900, qty: 10 }]),
        trade(sameSecond, [{ t_ms: sameSecond, side: 1, price: 27000, qty: 10 }]),
      ],
      ob: [deep(sameSecond, 20000, 27000)],
    });

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 27000,
      qty: 20000,
      t_ms: sameSecond,
    });
  });


  it('omits today traded baseline when no traded peak exists even though all-price REST data exists', () => {
    const restPeak = todayAskPeak({
      traded_price: null,
      traded_qty: null,
      traded_t_ms: null,
    });

    const { result } = renderHook(
      () => useDayAskPeaks([], [], [], '20260613', OPEN_MS, '005930', restPeak),
    );

    // 체결 기준선(carrier)은 승격되지 않는다 — 행은 전체 벽 패밀리 운반용으로만 남는다.
    const today = result.current.find((p) => p.date === '20260613');
    expect(today).toMatchObject({ price: null, qty: null, t_ms: null });
    expect(today?.all_peaks).toContainEqual({ price: 26000, qty: 12000, t_ms: atKst(9, 11) });
  });

  // ── 유효 스냅샷 술어(동시호가·VI 3호가 붕괴 배제) ─────────────────────────
  //
  // 종전엔 삭제된 `useTodayAllPriceAskPeak` 훅을 통해 간접 검증했다. ADR-0156 이 그
  // 훅(미체결 선 전용)을 지우면서, 술어를 **직접** 부르는 형태로 옮긴다 — 훅이
  // 사라졌다고 이 커버리지까지 잃으면 안 된다.
  const allWalls = (ob: ObSnapshot[]) =>
    classifyAskWallEvents(toWallEventsFromOrderbooks(ob, 'ask', OPEN_MS), []).all;

  it('ignores collapsed 3-level auction/VI books', () => {
    const collapsed: ObSnapshot = {
      t_ms: atKst(10, 0),
      total_ask_qty: 100001,
      total_bid_qty: 3,
      asks: [
        { price: 29000, qty: 99999 },
        { price: 29100, qty: 1 },
        { price: 29200, qty: 1 },
        ...Array.from({ length: 7 }, () => ({ price: 0, qty: 0 })),
      ],
      bids: [
        { price: 28900, qty: 1 },
        { price: 28800, qty: 1 },
        { price: 28700, qty: 1 },
        ...Array.from({ length: 7 }, () => ({ price: 0, qty: 0 })),
      ],
    };

    expect(allWalls([collapsed])).toEqual([]);
    expect(allWalls([collapsed, deep(atKst(10, 1), 12000, 26000)])[0])
      .toEqual({ price: 26000, qty: 12000, t_ms: atKst(10, 1) });
  });

  it('ignores one-sided collapsed ask books even when bids remain deep', () => {
    const oneSidedCollapsed: ObSnapshot = {
      t_ms: atKst(10, 0),
      total_ask_qty: 100001,
      total_bid_qty: 1000,
      asks: [
        { price: 29000, qty: 99999 },
        { price: 29100, qty: 1 },
        { price: 29200, qty: 1 },
        ...Array.from({ length: 7 }, () => ({ price: 0, qty: 0 })),
      ],
      bids: Array.from({ length: 10 }, (_, i) => ({ price: 28900 - i * 100, qty: 100 })),
    };

    expect(allWalls([oneSidedCollapsed])).toEqual([]);
  });

  // (제거됨, issue #434) 대량 버퍼 무정지 벽시계 테스트는 full-suite 워커 경합에
  // flaky했다. 이 훅이 쓰는 IncrementalPeakWallSource의 append-only 델타 소비(perf를
  // 담보하는 실제 불변식)는 useDayPeaks.perf.test.tsx가 결정론적 호출횟수로 검증한다.
});

describe('useDayAskPeaks — 미도달 벽 패밀리', () => {
  it('백엔드 unreached 시드는 새 고가로 재필터된다(소급 제거의 클라이언트 절반)', () => {
    const restPeak = todayAskPeak({
      day_extreme: 26_000,
      unreached_price: 26_500,
      unreached_qty: 8_000,
      unreached_t_ms: atKst(9, 5),
    });
    const { result, rerender } = renderHook(
      ({ trades }: { trades: TradeSnapshot[] }) =>
        useDayAskPeaks([], trades, [], '20260613', OPEN_MS, '005930', restPeak),
      { initialProps: { trades: [] as TradeSnapshot[] } },
    );

    // 고가 26,000 아래에서는 26,500 벽이 미도달로 살아 있다.
    let today = result.current.find((p) => p.date === '20260613');
    expect(today?.unreached_peaks).toContainEqual({ price: 26_500, qty: 8_000, t_ms: atKst(9, 5) });

    // 버퍼 체결이 26,600 신고가를 찍으면 시드가 걸러진다 — 백엔드 스냅샷은 그대로인데도.
    rerender({
      trades: [trade(atKst(9, 30), [{ t_ms: atKst(9, 30), side: 1, price: 26_600, qty: 1 }])],
    });
    today = result.current.find((p) => p.date === '20260613');
    expect(today?.unreached_peaks ?? []).not.toContainEqual(
      { price: 26_500, qty: 8_000, t_ms: atKst(9, 5) },
    );
  });

  it('창 내 벽은 백엔드 day_extreme 기준으로 미도달이 갈린다(접속 이전 고가 반영)', () => {
    const restPeak = todayAskPeak({ day_extreme: 26_000 });
    const t = atKst(9, 20);
    const { result } = renderHook(() => useDayAskPeaks(
      // 26,300 벽(고가 위)과 25,900 벽(고가 아래) — 체결 틱 없이 호가만.
      [deep(t, 4_000, 26_300), deep(t + 1_000, 9_000, 25_900)],
      [],
      [],
      '20260613', OPEN_MS, '005930', restPeak,
    ));

    const today = result.current.find((p) => p.date === '20260613');
    expect(today?.unreached_peaks).toContainEqual({ price: 26_300, qty: 4_000, t_ms: t });
    expect(today?.unreached_peaks ?? []).not.toContainEqual(
      { price: 25_900, qty: 9_000, t_ms: t + 1_000 },
    );
    // rank-1 스칼라도 같은 후보를 나른다(리맵의 carrier).
    expect(today?.unreached_price).toBe(26_300);
  });

  it('체결 극값을 아예 모르면(백엔드 없음·체결 0건) 모든 벽이 미도달이다', () => {
    const t = atKst(9, 20);
    const { result } = renderHook(() => useDayAskPeaks(
      [deep(t, 7_000, 26_100)], [], [], '20260613', OPEN_MS, '005930',
    ));
    const today = result.current.find((p) => p.date === '20260613');
    expect(today?.unreached_peaks?.[0]).toEqual({ price: 26_100, qty: 7_000, t_ms: t });
  });
});

describe('useDayAskPeaks — 기록 갱신 시퀀스(최대벽 강도 pane 계단의 입력)', () => {
  // 오늘 행은 라이브 파생이 통째로 대체하지만(`seeds.filter`), 기록만은 세 출처에서
  // 모아야 한다: seed(개장~프로모션) · 라이브 스냅샷(마운트 시점 서버 상태) · 접속 이후
  // 누적. 종전엔 이 자리에 **그 순간의 top-3** 이 들어가 있어서, 장중에 더 큰 벽이 서서
  // top-3 이 뒤로 몰릴 때마다 계단의 **왼쪽 끝이 오른쪽으로 후퇴**했다.

  const seedWithRecords = (records: {
    close: AskPeak['traded_record_peaks'];
    max: AskPeak['traded_record_max_peaks'];
  }): AskPeak => ({
    date: '20260613',
    price: 25100, qty: 5000, t_ms: atKst(9, 1),
    max_price: 25100, max_qty: 5000, max_t_ms: atKst(9, 1),
    traded_record_peaks: records.close,
    traded_record_max_peaks: records.max,
  });

  it('오늘 seed 행은 버려져도 기록 갱신 시퀀스는 오늘 행에 살아남는다', () => {
    const morning = { price: 25100, qty: 5000, t_ms: atKst(9, 1) };
    const morningCont = { price: 25100, qty: 5200, t_ms: atKst(9, 1) };
    const { result } = renderHook(() => useDayAskPeaks(
      [], [], [seedWithRecords({ close: [morning], max: [morningCont] })],
      '20260613', OPEN_MS, '005930', todayAskPeak(),
    ));

    const today = result.current.find((p) => p.date === '20260613')!;
    // carrier 는 여전히 라이브 파생이다(seed 의 5000 이 아니다) — 버리는 규약은 그대로.
    expect(today.qty).toBe(9000);
    // 오전 기록이 남는다. 두 축이 **따로** 실린다(seed 는 rep/cont 가 다르다).
    expect(today.traded_record_peaks).toContainEqual(morning);
    expect(today.traded_record_max_peaks).toContainEqual(morningCont);
    expect(today.traded_record_max_peaks).not.toContainEqual(morning);
  });

  it('기록은 seed(오전)와 라이브 스냅샷(당일 전체)의 합집합이다', () => {
    const morning = { price: 25100, qty: 5000, t_ms: atKst(9, 1) };
    const afternoon = { price: 25500, qty: 9000, t_ms: atKst(13, 0) };
    const { result } = renderHook(() => useDayAskPeaks(
      [], [], [seedWithRecords({ close: [morning], max: [morning] })],
      '20260613', OPEN_MS, '005930',
      // 라이브 top-3 을 기록과 같은 벽으로 맞춰 둔다 — 누적기 기여가 이 둘과 겹쳐
      // 합집합이 정확히 둘이 되므로, 이 테스트가 재는 것이 **병합**만 남는다.
      todayAskPeak({
        traded_record_peaks: [afternoon],
        traded_price: afternoon.price,
        traded_qty: afternoon.qty,
        traded_t_ms: afternoon.t_ms,
      }),
    ));

    const today = result.current.find((p) => p.date === '20260613')!;
    expect(today.traded_record_peaks).toEqual([morning, afternoon]);
    expect(today.traded_record_max_peaks).toEqual([morning, afternoon]);
  });

  // ── 접속 이후 누적(옵션 b) — 잔여 창을 닫는 절 ─────────────────────────────
  //
  // 판별식은 **단조성**이다: 첫 프레임만 보면 누적기와 "top-3 을 그냥 싣기" 가 구별되지
  // 않는다(관측이 한 번뿐이라 합집합 = 그 top-3). 순위가 갱신된 **뒤에** 이전 기록이
  // 남아 있는가가 두 동작을 가른다 — 그게 사용자가 보고한 증상이다.

  it('순위가 갱신돼도 접속 이후에 세운 기록은 남는다', () => {
    const early = atKst(9, 20);
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, [], '20260613', OPEN_MS, '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    // 09:20 — 작은 벽 하나가 서고 체결이 그걸 때린다. 그 순간의 유일한 기록이다.
    rerender({
      ob: [deep(early, 1_000)],
      trades: [trade(early + 1_000, [{ t_ms: early + 1_000, side: 1, price: 26000, qty: 10 }])],
    });
    const first = result.current.find((p) => p.date === '20260613')!;
    expect(first.traded_record_peaks).toContainEqual({ price: 26000, qty: 1_000, t_ms: early });

    // 13:00 — 훨씬 큰 벽 셋이 서서 top-3 을 통째로 밀어낸다.
    const late = atKst(13, 0);
    rerender({
      ob: [
        deep(early, 1_000),
        deep(late, 50_000, 26_010),
        deep(late + 1_000, 40_000, 26_020),
        deep(late + 2_000, 30_000, 26_030),
      ],
      trades: [
        trade(early + 1_000, [{ t_ms: early + 1_000, side: 1, price: 26000, qty: 10 }]),
        trade(late + 3_000, [{ t_ms: late + 3_000, side: 1, price: 26_030, qty: 10 }]),
      ],
    });
    const second = result.current.find((p) => p.date === '20260613')!;
    // top-3 에서는 밀려났지만…
    expect(second.traded_peaks).not.toContainEqual({ price: 26000, qty: 1_000, t_ms: early });
    // …기록에는 남는다. 이게 없으면 계단의 09:20 계단이 사라진다.
    expect(second.traded_record_peaks).toContainEqual({ price: 26000, qty: 1_000, t_ms: early });
    expect(second.traded_record_max_peaks).toContainEqual({ price: 26000, qty: 1_000, t_ms: early });
  });

  it('종목이 바뀌면 누적을 버린다 — 옛 종목의 기록이 새 종목에 새지 않는다', () => {
    const early = atKst(9, 20);
    const props = {
      ob: [deep(early, 1_000)],
      trades: [trade(early + 1_000, [{ t_ms: early + 1_000, side: 1, price: 26000, qty: 10 }])],
      code: '005930',
    };
    const { result, rerender } = renderHook(
      ({ ob, trades, code }: typeof props) =>
        useDayAskPeaks(ob, trades, [], '20260613', OPEN_MS, code),
      { initialProps: props },
    );
    expect(result.current.find((p) => p.date === '20260613')!.traded_record_peaks)
      .toContainEqual({ price: 26000, qty: 1_000, t_ms: early });

    // 같은 버퍼를 그대로 두고 종목만 바꾼다 — 누적기만 재는 조작이다.
    rerender({ ...props, ob: [], trades: [], code: '000660' });
    const after = result.current.find((p) => p.date === '20260613');
    expect(after?.traded_record_peaks ?? []).toEqual([]);
  });

  it('derive 자체는 기록 자리에 top-3 을 넣지 않는다(누적은 훅의 일이다)', () => {
    // 하류(expandBaselinePeaks)가 기록 ∪ top-3 을 후보로 쓰므로 폴백은 거기서 난다.
    // derive 가 top-3 을 실으면 배치판과의 동등성 위에서 "기록" 의 뜻이 무너진다.
    const rows = deriveDayAskPeaksIncremental(
      new IncrementalPeakWallSource('ask'),
      [], [], [], '20260613', OPEN_MS, todayAskPeak(),
    );
    const today = rows.find((p) => p.date === '20260613')!;
    expect(today.traded_peaks?.length).toBeGreaterThan(0);
    expect(today.traded_record_peaks).toEqual([]);
    expect(today.traded_record_max_peaks).toEqual([]);
  });
});

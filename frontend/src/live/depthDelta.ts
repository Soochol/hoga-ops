import type { OrderbookLevel } from '../api/types';

/** 한 가격 단의 잔량 증감 누적. `inQty`/`outQty` 는 **둘 다 양수 크기**다(부호 없음) —
 *  순증감은 `netDeltaQty()` 한 곳에서만 유도한다. 값에 부호를 싣지 않는 이유: 색 선택과
 *  포매팅이 각자 부호를 재해석하다 어긋나는 것을 막고, "들어오고 빠진 총량"(공방 강도)이
 *  net 으로 상쇄돼 사라지지 않게 하기 위함. */
export type DepthDeltaLevel = { price: number; inQty: number; outQty: number };

/** 한 버킷의 매도/매수 단별 증감. 레벨은 **가격 오름차순**(오라클·증분 공통 규약).
 *  증감이 0 인 가격은 담지 않는다 — 셀을 그리지 않을 값이라 point 크기만 키운다. */
export type DepthDeltaPoint = {
  tMs: number;
  askDelta: DepthDeltaLevel[];
  bidDelta: DepthDeltaLevel[];
  /** 매도/매수 사다리에서 각각 관측된 호가 단위(틱). 셀 높이가 정확히 1틱이 되게 하려고
   *  point 에 싣는다 — 히트맵은 조밀한 10단 사다리에서 틱을 역산할 수 있지만, 증감
   *  레벨은 **변한 가격만** 남은 희소 집합이라 역산이 틀린다(한 가격만 변하면 아예 못
   *  구하고, 두 가격이 3단 떨어져 변하면 3배로 부푼다). 0 = 관측 불가(호출부 폴백).
   *
   *  ⚠️ 매도·매수를 하나로 합치지 않는다: KRX 호가단위는 가격대 경계(2천/5천/2만/5만/
   *  20만/50만)에서 바뀌므로 현재가가 경계에 걸치면 두 사다리의 틱이 실제로 다르다
   *  (예: 현재가 5만원 부근 → 매수 50원, 매도 100원). 합쳐서 최솟값을 쓰면 넓은 쪽 셀이
   *  실제 틱의 절반(20만 경계에서는 1/5) 높이로 그려져 줄무늬가 생긴다. */
  askTick: number;
  bidTick: number;
};

/** 버킷 누적기(가격 → 유입/유출 합). point 와 **형제**로 보관해야 한다 — point 안에
 *  넣고 in-place 로 더하면 참조 안정 불변식(미변경 버킷 = 같은 객체)이 깨진다. */
export type DeltaAcc = Map<number, { in: number; out: number }>;

export function netDeltaQty(level: DepthDeltaLevel): number {
  return level.inQty - level.outQty;
}

/** 연속 두 호가창 한쪽(매도 또는 매수)의 증감을 `acc` 에 누적한다. 오라클과 증분 미러가
 *  **공유하는 유일한 계산** — 규칙 자체가 갈라지는 것을 구조적으로 막는다(버킷 순회는
 *  일부러 각자 구현해 패리티 테스트가 동어반복이 되지 않게 한다).
 *
 *  규칙(설계 §2):
 *  - **가격 교집합만** diff 한다. 10단 관측창은 현재가를 따라 미끄러지므로, 한쪽에만 있는
 *    가격의 잔량은 주문 변화가 아니라 **창 이동 아티팩트**다. 이를 증감으로 세면 현재가가
 *    한 틱 움직일 때마다 거대한 가짜 유입/유출이 찍힌다.
 *  - 호출자가 매도는 매도끼리, 매수는 매수끼리만 넘긴다. 합쳐서 diff 하면 현재가 이동 시
 *    같은 가격이 매도단→매수단으로 넘어간 것(서로 무관한 주문)을 연속으로 오인한다.
 *  - `price <= 0` 은 사다리 빈 칸(애프터마켓 `-0` 등)이라 건너뛴다. `qty === 0` 은 실제
 *    관측(잔량 없음)이므로 0→N 은 정상 유입으로 센다.
 *
 *  @returns 0 이 아닌 증감을 하나라도 누적했으면 true. */
export function foldLevelDiff(
  prev: readonly OrderbookLevel[],
  cur: readonly OrderbookLevel[],
  acc: DeltaAcc,
): boolean {
  const prevQty = new Map<number, number>();
  for (const lvl of prev) {
    if (lvl.price > 0) prevQty.set(lvl.price, lvl.qty);
  }
  let folded = false;
  for (const lvl of cur) {
    if (lvl.price <= 0) continue;
    const before = prevQty.get(lvl.price);
    if (before === undefined) continue; // 교집합 밖 = 창 이동, 증감 아님
    const delta = lvl.qty - before;
    if (delta === 0) continue;
    let entry = acc.get(lvl.price);
    if (!entry) {
      entry = { in: 0, out: 0 };
      acc.set(lvl.price, entry);
    }
    if (delta > 0) entry.in += delta;
    else entry.out += -delta;
    folded = true;
  }
  return folded;
}

/** 누적기 → 방출용 레벨 배열(가격 오름차순, 순증감 0 인 가격도 유입·유출이 있으면 유지).
 *  항상 **새 배열**을 만든다 — 저장된 point 를 in-place 수정하지 않기 위한 규율. */
export function deltaAccToLevels(acc: DeltaAcc): DepthDeltaLevel[] {
  const out: DepthDeltaLevel[] = [];
  for (const [price, v] of acc) {
    if (v.in === 0 && v.out === 0) continue;
    out.push({ price, inQty: v.in, outQty: v.out });
  }
  out.sort((a, b) => a.price - b.price);
  return out;
}

/** 한쪽 사다리(매도 **또는** 매수)에서 관측되는 호가 단위 = 인접 가격 간격의 **중앙값**.
 *
 *  사다리는 10단 연속이라 간격이 곧 틱이다. 최솟값이 아니라 중앙값을 쓰는 이유: 사다리가
 *  호가단위 경계를 걸치면 두 종류의 간격이 섞이는데(예: 49,900~50,700 → 50원과 100원),
 *  최솟값을 쓰면 넓은 쪽 셀이 실제 틱의 절반 높이로 그려져 칠해지지 않는 띠가 생긴다.
 *  중앙값은 다수를 차지하는 간격을 고르므로 경계 근처에서도 대표값이 안정적이다.
 *
 *  유효 가격이 2개 미만이면 Infinity(관측 불가). ⚠️ 매도·매수를 **합쳐서** 구하면 안 된다 —
 *  최우선 매수/매도 사이의 스프레드는 틱이 아니다. */
export function ladderTick(levels: readonly OrderbookLevel[]): number {
  const prices = levels
    .filter((l) => l.price > 0 && Number.isFinite(l.price))
    .map((l) => l.price)
    .sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const gap = prices[i] - prices[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return Number.POSITIVE_INFINITY;
  gaps.sort((a, b) => a - b);
  // 짝수 개면 아래쪽 중앙값 — 두 틱이 정확히 반반일 때 좁은 쪽을 고르는 편이
  // 셀이 이웃을 침범하지 않아 안전하다.
  return gaps[Math.floor((gaps.length - 1) / 2)];
}

/** 누적기 한 쌍 → 버킷 point. 양쪽 모두 비면 null(= 그 버킷은 방출하지 않는다).
 *  오라클·증분이 같은 "빈 버킷 드롭" 정책을 쓰게 하는 단일 지점. */
export function makeDeltaPoint(
  tMs: number,
  ask: DeltaAcc,
  bid: DeltaAcc,
  askTick: number,
  bidTick: number,
): DepthDeltaPoint | null {
  const askDelta = deltaAccToLevels(ask);
  const bidDelta = deltaAccToLevels(bid);
  if (askDelta.length === 0 && bidDelta.length === 0) return null;
  return {
    tMs,
    askDelta,
    bidDelta,
    askTick: Number.isFinite(askTick) ? askTick : 0,
    bidTick: Number.isFinite(bidTick) ? bidTick : 0,
  };
}

/** 두 스냅샷을 이어서 diff 해도 되는가 — 같은 거래소(venue)여야 한다.
 *  KRX 호가장과 NXT 호가장은 별개 장부라 교차 diff 는 무의미하다(#524 시분할). */
export function sameDeltaChain(
  prev: { venue?: 'KRX' | 'NXT' },
  cur: { venue?: 'KRX' | 'NXT' },
): boolean {
  return prev.venue === cur.venue;
}

import type { AskPeakCandidate } from '../api/types';
import { isIndicatorEligibleBook, type ObSnapshot, type TradeSnapshot } from './bucketHogaSeries';
import type { PeakWallClassification } from './peakWallEventClassifier';

const EMIT_LIMIT = 3;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** rankPeakCandidates(peakWallEventClassifier.ts)와 동일한 전순서:
 *  qty desc, t_ms asc, price asc. 세 필드가 모두 같으면 동일 후보(중복 제거 대상)라
 *  전순서가 총순서이고, top-3 선택 결과가 정렬 상위 3개와 항상 일치한다. */
function cmpCandidates(a: AskPeakCandidate, b: AskPeakCandidate): number {
  return b.qty - a.qty || a.t_ms - b.t_ms || a.price - b.price;
}

/** 정렬 유지 삽입으로 top-3 유지. */
function pushTopK(top: AskPeakCandidate[], candidate: AskPeakCandidate): void {
  let i = top.length;
  while (i > 0 && cmpCandidates(candidate, top[i - 1]) < 0) i -= 1;
  if (i >= EMIT_LIMIT) return;
  top.splice(i, 0, candidate);
  if (top.length > EMIT_LIMIT) top.pop();
}

/** ob/trade 스냅샷 스트림에서 (벽 이벤트, 터치 틱) 추출·분류를 증분화한다.
 *
 *  prefix-guard는 IncrementalHogaBucketer(buildLiveBundle.ts)와 동일: 이전 배열의
 *  마지막 원소 "참조"가 새 배열의 같은 인덱스에 그대로 있으면 append-only로 간주해
 *  델타만 소비하고, 아니면(종목 전환·버퍼 리셋·테스트의 배열 교체) 전체 재소비로
 *  폴백한다. 폴백 경로가 배치(toWallEventsFromOrderbooks/toTouchTicksFromTrades →
 *  classifyWallEvents)와 연산이 동일하므로 정확성은 배치가 보증한다 — 증분은 오직
 *  "같은 결과를 덜 계산해서" 얻는 수단이다.
 *
 *  분류(classify)는 매 호출 누적 이벤트 전체에 대한 단일 숫자 패스다:
 *  touched 판정은 정렬된 터치 시각의 이진탐색 + suffix 극값(makeTouchIndex와 동일
 *  수식), 각 패밀리는 top-3 삽입 선택. classifyWallEvents가 EMIT_LIMIT=3만 방출하므로
 *  결과가 배치와 동일하다. 문자열 키는 이벤트 "삽입 시 1회"만 생성된다(배치는 매 틱
 *  전체 재생성).
 *
 *  주의: 소비자는 반환된 배열을 다음 update() 호출 전까지만 신뢰할 것(내부 재사용
 *  없음 — 매 호출 새 top-3 배열이지만, 이벤트 객체는 공유). */
export class IncrementalPeakWallSource {
  private readonly side: 'ask' | 'bid';
  private obLength = 0;
  private lastObRef: ObSnapshot | null = null;
  private tradeLength = 0;
  private lastTradeRef: TradeSnapshot | null = null;
  /** 누적 벽 이벤트 — toWallEventsFromOrderbooks와 동일 키(price:t_ms)·동일 max-qty 규칙. */
  private events: AskPeakCandidate[] = [];
  private eventIndexByKey = new Map<string, number>();
  /** 누적 터치 틱 — toTouchTicksFromTrades와 동일 필터. */
  private touchTimes: number[] = [];
  private touchPrices: number[] = [];
  private touchesSorted = true;
  private touchIndexDirty = true;
  private suffixExtreme: number[] = [];

  constructor(side: 'ask' | 'bid') {
    this.side = side;
  }

  update(
    ob: ReadonlyArray<ObSnapshot>,
    trade: ReadonlyArray<TradeSnapshot>,
    extras: readonly AskPeakCandidate[] = [],
  ): PeakWallClassification {
    this.accumulate(ob, trade);
    return this.classify(extras);
  }

  /** update 의 as-of-cutoff 판. 누적(ob/trade 소비)은 cutoff 무관하게 동일하고, 분류만
   *  t_ms <= cutoffMs 로 제한한다 — 배치 deriveDay*Peaks(cutoff)와 동일하게 cutoff 이하
   *  ob/trade 로 벽·터치를 재평가한다(터치 관계도 cutoff 기준). ob/trade 재스캔 없이
   *  누적 구조만 필터링하므로 틱당 비용이 히스토리 재빌드에서 분리된다. */
  updateAsOf(
    ob: ReadonlyArray<ObSnapshot>,
    trade: ReadonlyArray<TradeSnapshot>,
    extras: readonly AskPeakCandidate[],
    cutoffMs: number,
  ): PeakWallClassification {
    this.accumulate(ob, trade);
    return this.classifyAsOf(extras, cutoffMs);
  }

  private accumulate(
    ob: ReadonlyArray<ObSnapshot>,
    trade: ReadonlyArray<TradeSnapshot>,
  ): void {
    if (!this.canAppendOb(ob) || !this.canAppendTrade(trade)) {
      this.reset();
      this.consumeOb(ob);
      this.consumeTrade(trade);
    } else {
      if (ob.length > this.obLength) this.consumeOb(ob.slice(this.obLength));
      if (trade.length > this.tradeLength) this.consumeTrade(trade.slice(this.tradeLength));
    }
    this.obLength = ob.length;
    this.lastObRef = ob.length > 0 ? ob[ob.length - 1] : null;
    this.tradeLength = trade.length;
    this.lastTradeRef = trade.length > 0 ? trade[trade.length - 1] : null;
  }

  private reset(): void {
    this.events = [];
    this.eventIndexByKey = new Map();
    this.touchTimes = [];
    this.touchPrices = [];
    this.touchesSorted = true;
    this.touchIndexDirty = true;
    this.suffixExtreme = [];
  }

  private canAppendOb(ob: ReadonlyArray<ObSnapshot>): boolean {
    if (ob.length < this.obLength) return false;
    if (this.obLength === 0) return true;
    return ob[this.obLength - 1] === this.lastObRef;
  }

  private canAppendTrade(trade: ReadonlyArray<TradeSnapshot>): boolean {
    if (trade.length < this.tradeLength) return false;
    if (this.tradeLength === 0) return true;
    return trade[this.tradeLength - 1] === this.lastTradeRef;
  }

  private consumeOb(snapshots: ReadonlyArray<ObSnapshot>): void {
    for (const snapshot of snapshots) {
      if (!isIndicatorEligibleBook(snapshot)) continue;
      const levels = this.side === 'ask' ? snapshot.asks : snapshot.bids;
      if (!levels) continue;
      for (const level of levels) {
        if (!isFiniteNumber(level.price) || !isFiniteNumber(level.qty) || level.qty <= 0) continue;
        const key = `${level.price}:${snapshot.t_ms}`;
        const index = this.eventIndexByKey.get(key);
        if (index === undefined) {
          this.eventIndexByKey.set(key, this.events.length);
          this.events.push({ price: level.price, qty: level.qty, t_ms: snapshot.t_ms });
        } else if (level.qty > this.events[index].qty) {
          this.events[index] = { price: level.price, qty: level.qty, t_ms: snapshot.t_ms };
        }
      }
    }
  }

  private consumeTrade(snapshots: ReadonlyArray<TradeSnapshot>): void {
    for (const snapshot of snapshots) {
      for (const item of snapshot.trades) {
        if ((item.side !== 1 && item.side !== -1) || !isFiniteNumber(item.price)) continue;
        const tMs = isFiniteNumber(item.t_ms) ? item.t_ms : snapshot.t_ms;
        if (!isFiniteNumber(tMs) || tMs <= 0) continue;
        if (this.touchTimes.length > 0 && tMs < this.touchTimes[this.touchTimes.length - 1]) {
          this.touchesSorted = false;
        }
        this.touchTimes.push(tMs);
        this.touchPrices.push(item.price);
        this.touchIndexDirty = true;
      }
    }
  }

  /** 터치 배열을 시각 오름차순으로 정렬(이진탐색 전제). 정렬이 일어나면 suffixExtreme
   *  캐시가 무효화되므로 touchIndexDirty 를 세운다. */
  private ensureTouchesSorted(): void {
    if (this.touchesSorted) return;
    const order = this.touchTimes
      .map((_, i) => i)
      .sort((a, b) => this.touchTimes[a] - this.touchTimes[b]);
    this.touchTimes = order.map((i) => this.touchTimes[i]);
    this.touchPrices = order.map((i) => this.touchPrices[i]);
    this.touchesSorted = true;
    this.touchIndexDirty = true;
  }

  /** makeTouchIndex(peakWallEventClassifier.ts)와 동일한 인덱스를 터치가 자랄 때만 재구축. */
  private ensureTouchIndex(): void {
    this.ensureTouchesSorted();
    if (!this.touchIndexDirty) return;
    const n = this.touchTimes.length;
    const suffix = new Array<number>(n + 1);
    suffix[n] = this.side === 'ask' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (let i = n - 1; i >= 0; i -= 1) {
      suffix[i] = this.side === 'ask'
        ? Math.max(this.touchPrices[i], suffix[i + 1])
        : Math.min(this.touchPrices[i], suffix[i + 1]);
    }
    this.suffixExtreme = suffix;
    this.touchIndexDirty = false;
  }

  private isTouched(event: AskPeakCandidate): boolean {
    const n = this.touchTimes.length;
    if (n === 0) return false;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.touchTimes[mid] < event.t_ms) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= n) return false;
    const extreme = this.suffixExtreme[lo];
    return this.side === 'ask' ? extreme >= event.price : extreme <= event.price;
  }

  private classify(extras: readonly AskPeakCandidate[]): PeakWallClassification {
    this.ensureTouchIndex();
    const postTouch: AskPeakCandidate[] = [];
    const postUntouched: AskPeakCandidate[] = [];
    const all: AskPeakCandidate[] = [];
    const consider = (candidate: AskPeakCandidate) => {
      pushTopK(all, candidate);
      if (this.isTouched(candidate)) pushTopK(postTouch, candidate);
      else pushTopK(postUntouched, candidate);
    };
    for (const event of this.events) consider(event);
    // extras(백엔드 피크 후보·seed)는 호출마다 달라질 수 있어 누적하지 않고 매번
    // 분류한다. 배치의 uniqueCandidates(price:qty:t_ms 키)와 동치인 중복 제거:
    // extras 상호 간 + 누적 이벤트와의 중복(같은 price:t_ms에 같은 qty)을 걸러낸다.
    const seenExtras = new Set<string>();
    for (const extra of extras) {
      const uniqKey = `${extra.price}:${extra.qty}:${extra.t_ms}`;
      if (seenExtras.has(uniqKey)) continue;
      seenExtras.add(uniqKey);
      const accumulatedIndex = this.eventIndexByKey.get(`${extra.price}:${extra.t_ms}`);
      if (accumulatedIndex !== undefined && this.events[accumulatedIndex].qty === extra.qty) continue;
      consider(extra);
    }
    return { postTouch, postUntouched, all };
  }

  /** classify 의 as-of-cutoff 판. 이벤트·extras·터치를 t_ms <= cutoffMs 로 제한한다.
   *  cutoff 는 팬으로 이동하므로 suffixExtreme 를 캐시하지 않고, cutoff 이하 터치
   *  prefix [0, hi) 에 대한 suffixExtremeC 를 호출마다 O(hi) 로 빌드한다(sparse table
   *  불필요). 배치 mergedAskFamilies 의 cutoff 분기와 동일: cutoff 이하 터치로만 벽의
   *  touched 여부를 재평가한다. no-cutoff classify 의 dedup·top-3 규칙을 그대로 상속. */
  private classifyAsOf(
    extras: readonly AskPeakCandidate[],
    cutoffMs: number,
  ): PeakWallClassification {
    this.ensureTouchesSorted();
    const n = this.touchTimes.length;
    // hi = cutoff 이하 터치 개수(upper bound).
    let lo = 0;
    let hiBound = n;
    while (lo < hiBound) {
      const mid = (lo + hiBound) >>> 1;
      if (this.touchTimes[mid] <= cutoffMs) lo = mid + 1;
      else hiBound = mid;
    }
    const hi = lo;
    // suffixExtreme over [0, hi): suffix[i] = extreme(touchPrices[i..hi-1]).
    const suffix = new Array<number>(hi + 1);
    suffix[hi] = this.side === 'ask' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (let i = hi - 1; i >= 0; i -= 1) {
      suffix[i] = this.side === 'ask'
        ? Math.max(this.touchPrices[i], suffix[i + 1])
        : Math.min(this.touchPrices[i], suffix[i + 1]);
    }
    const isTouchedC = (event: AskPeakCandidate): boolean => {
      if (hi === 0) return false;
      let l = 0;
      let h = hi;
      while (l < h) {
        const mid = (l + h) >>> 1;
        if (this.touchTimes[mid] < event.t_ms) l = mid + 1;
        else h = mid;
      }
      if (l >= hi) return false;
      const extreme = suffix[l];
      return this.side === 'ask' ? extreme >= event.price : extreme <= event.price;
    };
    const postTouch: AskPeakCandidate[] = [];
    const postUntouched: AskPeakCandidate[] = [];
    const all: AskPeakCandidate[] = [];
    const consider = (candidate: AskPeakCandidate) => {
      if (candidate.t_ms > cutoffMs) return;
      pushTopK(all, candidate);
      if (isTouchedC(candidate)) pushTopK(postTouch, candidate);
      else pushTopK(postUntouched, candidate);
    };
    for (const event of this.events) consider(event);
    const seenExtras = new Set<string>();
    for (const extra of extras) {
      if (extra.t_ms > cutoffMs) continue;
      const uniqKey = `${extra.price}:${extra.qty}:${extra.t_ms}`;
      if (seenExtras.has(uniqKey)) continue;
      seenExtras.add(uniqKey);
      const accumulatedIndex = this.eventIndexByKey.get(`${extra.price}:${extra.t_ms}`);
      if (accumulatedIndex !== undefined && this.events[accumulatedIndex].qty === extra.qty) continue;
      consider(extra);
    }
    return { postTouch, postUntouched, all };
  }
}

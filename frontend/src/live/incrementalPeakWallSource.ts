import type { AskPeakCandidate } from '../api/types';
import { isIndicatorEligibleBook, type ObSnapshot, type TradeSnapshot } from './bucketHogaSeries';
import { touchWindowOf, type PeakWallClassification } from './peakWallEventClassifier';

const EMIT_LIMIT = 3;

/** 슬라이딩이 좌절된 사유 — 진단용. 값 자체가 다음 조사자의 출발점이라 이름을 남긴다. */
export type FallbackReason =
  /** 이전 tail 이 새 배열에 없다 — 종목 전환·버퍼 리셋·통째 교체(정상 폴백). */
  | 'buffer-replaced'
  /** 같은 price:t_ms 가 두 스냅샷에서 나왔다 — 축출 판정이 모호해진다. */
  | 't-ms-collision';

/**
 * 모든 인스턴스의 폴백 누적 — **장중 확인의 판별식**.
 *
 * 인스턴스를 레지스트리에 담지 않고 숫자만 모으는 이유: 소스는 `useRef` 로 훅 수명 내내
 * 살고 창을 닫아도 명시적 해제가 없다. 인스턴스를 붙들면 그게 곧 누수다.
 *
 * DEV 에서 `window.__peakWallFallbacks()` 로 읽는다. 장중에 이 값이 **0 에 머물러야**
 * 슬라이딩 최적화가 실제로 먹고 있는 것이다 — 폴백은 결과가 옳으므로 완벽하게 조용해서,
 * 세지 않으면 "프로덕션에서 통째로 무효" 를 알아챌 방법이 없다.
 */
const fallbackTotals: { total: number; byReason: Record<FallbackReason, number> } = {
  total: 0,
  byReason: { 'buffer-replaced': 0, 't-ms-collision': 0 },
};

export function peakWallFallbackTotals(): { total: number; byReason: Record<FallbackReason, number> } {
  return { total: fallbackTotals.total, byReason: { ...fallbackTotals.byReason } };
}

if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__peakWallFallbacks = peakWallFallbackTotals;
}

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
 *  버퍼는 세 가지 모양으로 바뀐다. 셋을 다 다뤄야 한다:
 *    ① **append-only** — 뒤에만 붙는다(장 초반, 버퍼가 아직 안 찼을 때).
 *    ② **통째 교체** — 종목 전환·리셋. 전량 재소비로 폴백.
 *    ③ **슬라이딩** — **앞을 자르고 뒤에 붙인다**(15분 창이 찬 뒤의 정상 상태).
 *
 *  종전 prefix-guard 는 ①만 알아봤다(`ob[L-1] === lastRef`). ③에서는 그 검사가 **항상
 *  실패**해 매 flush 마다 전량 재소비가 일어났고, 그게 장중 정상 상태였다. ADR-0106 이
 *  전제를 "참조 안정한 라이브 버퍼" 로 적고 폴백 트리거를 종목 전환·버퍼 리셋으로만
 *  열거한 것이 그 사각의 출처다 — #926 이 형제(버킷터)에서 같은 전제가 틀렸음을 이미
 *  실측했는데 이쪽은 남아 있었다.
 *
 *  실측(2026-08-17, 10레벨 연속북, 축출 정상상태 flush 1회):
 *    900: 1.66 → 0.20 ms · 4,500: 8.62 → 0.69 ms · 9,000: 18.39 → 1.62 ms ·
 *    18,000: 45.00 → 3.42 ms  (재소비가 전체의 88~90% 였다)
 *
 *  ③을 다루려면 **슬라이딩만으로는 부족하고 축출이 함께 와야 한다.** 가드만 관대하게
 *  만들면 누적 이벤트가 세션 내내 단조 증가해 ① classify 가 점점 느려지고 ② 창 밖으로
 *  밀려난 벽이 남아 배치 오라클과 갈린다(#926 이 버킷터에서 실측한 "오라클 ask_max 는
 *  5000→120 인데 누적본은 5000" 과 같은 실패). 그래서 `eventSeq` 기준 prefix 절단 +
 *  `head` 포인터 + trade 스냅샷별 터치 기여 개수를 같이 넣었다(각 필드 주석 참조).
 *
 *  **정확성은 언제나 폴백이 보증한다.** t_ms 중복처럼 축출 판정이 모호해지는
 *  입력에서는 sticky 플래그가 서서 ②로 떨어진다. 증분은 오직 "같은 결과를 덜 계산해서"
 *  얻는 수단이고, 그 등식을 `incrementalPeakWallEviction.test.ts` 가 매 스텝 오라클과
 *  대조해 못박는다(ask/bid × 일반/cutoff, 고정 시드).
 *
 *  분류(classify)는 매 호출 누적 이벤트 전체에 대한 단일 숫자 패스다: touched 판정은
 *  **분 단위 체결가 극값 맵** 조회(배치 touchExtremeByWindow/isWallTouched와 동일 수식,
 *  ADR-0156), 각 패밀리는 top-3 삽입 선택. classifyWallEvents가 EMIT_LIMIT=3만 방출하므로
 *  결과가 배치와 동일하다. 문자열 키는 이벤트 "삽입 시 1회"만 생성된다(배치는 매 틱
 *  전체 재생성).
 *
 *  ⚠ ADR-0084 시절엔 터치가 시간 역순으로 오면 정렬이 touchCounts 대응을 깨서 축출을
 *  폴백시켜야 했다. 분 단위 극값은 **순서에 무관**하므로 그 사유가 원리적으로 사라졌다.
 *
 *  주의: 소비자는 반환된 배열을 다음 update() 호출 전까지만 신뢰할 것(내부 재사용
 *  없음 — 매 호출 새 top-3 배열이지만, 이벤트 객체는 공유). */
export class IncrementalPeakWallSource {
  private readonly side: 'ask' | 'bid';
  /** 선택 venue 의 개장(유효 스냅샷 하한). 생성자가 아니라 update() 인자로 받는다 —
   *  호출부가 이 인스턴스를 useRef 로 훅 수명 내내 고정하므로, venue 전환을 인스턴스
   *  교체로 표현할 수 없다. 값이 바뀌면 accumulate() 가 누적을 버린다. */
  private sessionOpenMs = Number.NaN;
  private obLength = 0;
  private lastObRef: ObSnapshot | null = null;
  private tradeLength = 0;
  private lastTradeRef: TradeSnapshot | null = null;
  /** 누적 벽 이벤트 — toWallEventsFromOrderbooks와 동일 키(price:t_ms)·동일 max-qty 규칙. */
  private events: AskPeakCandidate[] = [];
  private eventIndexByKey = new Map<string, number>();
  /**
   * `events` 의 **논리 시작 인덱스**. 축출된 이벤트는 지우지 않고 head 를 올려 건너뛴다.
   *
   * 왜 splice 가 아닌가: `eventIndexByKey` 가 **절대 인덱스**를 담으므로 앞을 잘라내면
   * 맵 전체를 다시 만들어야 한다(18k 이벤트면 매 flush 마다 18k 삽입 — classify 전체
   * 비용과 맞먹는다). head 포인터면 맵이 그대로 유효하고, 죽은 항목은 `index >= head`
   * 검사로 걸러진다. 실제 압축은 head 가 절반을 넘을 때만(아래 `compactEvents`) —
   * 축출당 상각 O(1).
   *
   * ⚠ **`eventIndexByKey` 를 읽는 곳은 전부 `index >= this.head` 를 같이 봐야 한다.**
   * 세 곳이다: `consumeOb`(없는 것으로 취급해 새로 push), `classify`·`classifyAsOf` 의
   * extras dedup(죽은 이벤트와 qty 가 같다고 extras 를 건너뛰면 배치와 갈린다 — 배치는
   * 그 이벤트가 창에서 사라졌으므로 extras 를 **고려**한다).
   */
  private head = 0;
  /**
   * `events[i]` 를 **처음 만든 ob 스냅샷의 전역 순번**. 축출 판정의 유일한 근거다.
   *
   * t_ms 로 자르지 않는 이유: 두 스냅샷이 같은 t_ms 를 가지면 키(`price:t_ms`)가 겹쳐
   * "앞 스냅샷은 축출됐지만 뒤 스냅샷이 아직 창에 있는" 이벤트를 잘못 버리게 된다.
   * 순번은 그 모호함이 없다.
   *
   * **갱신(max-qty) 시 seq 를 올리지 않는다.** 올리면 비감소 불변식이 깨져 prefix 절단이
   * 일찍 멈추고 **버려야 할 이벤트를 남긴다** — 조용히 스테일해지는 방향이라 최악이다.
   * 대신 같은 키가 다른 순번에서 다시 나오면 `tMsCollisionSeen` 을 세워 축출을 폴백시킨다.
   */
  private eventSeq: number[] = [];
  /** 지금까지 소비한 ob 스냅샷 총수(단조). `eventSeq` 의 발급원. */
  private consumedObSeq = 0;
  /** 창에 남아 있는 첫 ob 스냅샷의 순번. 축출할 때만 올라간다. */
  private obBaseSeq = 0;
  /** 소비한 trade 스냅샷이 각각 몇 개의 터치를 기여했는가(축출량 환산용). */
  private touchCounts: number[] = [];
  /** 누적 터치 틱 — toTouchTicksFromTrades와 동일 필터. */
  private touchTimes: number[] = [];
  private touchPrices: number[] = [];
  /**
   * 분 → 그 분에 속한 터치 가격들(**도착 순**). `extremeByWindow` 를 축출 후에 다시
   * 세우기 위한 원천이다.
   *
   * 왜 이 배열이 필요한가: 극값은 **삭제가 안 되는 집계**다. 어떤 분의 max 가 축출되면
   * 남은 것들의 max 를 알 방법이 없어 그 분을 다시 훑어야 한다. 전량 `touchPrices` 를
   * 훑으면 원래 비용으로 돌아가므로, 분 단위로 갈라 두고 **그 분만** 훑는다.
   *
   * **도착 순이 prefix 대응을 만든다.** `touchTimes` 전체가 도착 순 push 이고 이 배열도
   * 같은 순서로 push 되므로, 전체 prefix 축출은 각 분 배열에서도 prefix 축출이다 —
   * 중간 삭제가 없다. 터치가 **시간 역순으로 도착해도** 성립한다(배열 순서는 도착 순이지
   * 시각 순이 아니다). ADR-0156 이 분 극값을 순서 무관으로 만든 덕이다.
   */
  private touchesByWindow = new Map<number, number[]>();
  /** 분 → 그 분 체결가의 극값. 삽입은 O(1) 갱신, 축출은 **닿은 분만** 재계산. */
  private extremeByWindow = new Map<number, number>();
  /**
   * 같은 `price:t_ms` 키가 **서로 다른 ob 스냅샷**에서 나왔다 = t_ms 중복.
   * 위 `eventSeq` 주석의 모호함이 실제로 발생했다는 뜻이라 축출을 폴백시킨다.
   *
   * **누적 상태에 대해 sticky, 세션에 대해서는 아니다.** `reset()` 이 지우므로, 폴백이
   * 한 번 일어나 전량 재소비를 하고 나면 그 시점 창에 충돌 쌍이 남아 있는 동안만 다시
   * 선다. 쌍이 창을 벗어나면 다음 축출부터 슬라이딩이 **저절로 재개**된다.
   */
  private tMsCollisionSeen = false;
  /**
   * 슬라이딩을 원했으나 전량 재소비로 떨어진 횟수와 마지막 사유.
   *
   * **왜 세는가**: 폴백은 결과가 옳으므로 **완벽하게 조용하다**. 실데이터가 t_ms 중복을
   * 자주 만들면 이 최적화가 프로덕션에서 통째로 무효인데 아무도 모른다 — 트랙 4 가 방금
   * 한 PR 을 들여 없앤 바로 그 「조용한 상태」다. 장중 확인의 판별식이 여기 있다:
   * `window.__peakWallDiag?.()` 가 0 에 머무는가.
   *
   * 세션 누적이 아니라 **인스턴스 누적**이다(훅 수명 = 창 수명).
   */
  private fallbacks = 0;
  private lastFallbackReason: FallbackReason | null = null;

  constructor(side: 'ask' | 'bid') {
    this.side = side;
  }

  update(
    ob: ReadonlyArray<ObSnapshot>,
    trade: ReadonlyArray<TradeSnapshot>,
    sessionOpenMs: number,
    extras: readonly AskPeakCandidate[] = [],
  ): PeakWallClassification {
    this.accumulate(ob, trade, sessionOpenMs);
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
    sessionOpenMs: number,
  ): PeakWallClassification {
    this.accumulate(ob, trade, sessionOpenMs);
    return this.classifyAsOf(extras, cutoffMs);
  }

  private accumulate(
    ob: ReadonlyArray<ObSnapshot>,
    trade: ReadonlyArray<TradeSnapshot>,
    sessionOpenMs: number,
  ): void {
    // 개장 하한이 바뀌면(venue 전환 KRX 09:00 ↔ NXT 08:00) 유효 스냅샷 집합 자체가
    // 달라지므로 누적을 통째로 버린다 — IncrementalHogaBucketer 의 리셋 트리거와 같은
    // 등급이다. 안 그러면 이전 venue 기준으로 걸러진 벽이 그대로 남는다.
    if (this.sessionOpenMs !== sessionOpenMs) {
      this.sessionOpenMs = sessionOpenMs;
      this.reset();
      this.obLength = 0;
      this.tradeLength = 0;
      this.lastObRef = null;
      this.lastTradeRef = null;
    }
    const obPlan = this.planSlide(ob, this.obLength, this.lastObRef);
    const tradePlan = this.planSlide(trade, this.tradeLength, this.lastTradeRef);
    const evicting = (obPlan?.evicted ?? 0) > 0 || (tradePlan?.evicted ?? 0) > 0;
    if (obPlan === null || tradePlan === null || (evicting && !this.canEvictSafely())) {
      // 첫 소비(prevLength 0)는 폴백이 아니다 — 셀 값이 있는 것만 센다.
      if (this.obLength > 0 || this.tradeLength > 0) {
        const reason: FallbackReason = obPlan === null || tradePlan === null
          ? 'buffer-replaced'
          : 't-ms-collision';
        this.fallbacks += 1;
        this.lastFallbackReason = reason;
        fallbackTotals.total += 1;
        fallbackTotals.byReason[reason] += 1;
      }
      this.reset();
      this.consumeOb(ob);
      this.consumeTrade(trade);
    } else {
      // 축출을 **먼저** 한다 — consumeOb 의 키 조회가 `index >= head` 로 죽은 항목을
      // 거르므로, 새 스냅샷이 방금 축출된 키를 다시 쓰더라도 새 이벤트로 들어간다.
      if (obPlan.evicted > 0) this.evictOb(obPlan.evicted);
      if (tradePlan.evicted > 0) this.evictTrades(tradePlan.evicted);
      if (obPlan.suffixFrom < ob.length) this.consumeOb(ob.slice(obPlan.suffixFrom));
      if (tradePlan.suffixFrom < trade.length) this.consumeTrade(trade.slice(tradePlan.suffixFrom));
    }
    this.obLength = ob.length;
    this.lastObRef = ob.length > 0 ? ob[ob.length - 1] : null;
    this.tradeLength = trade.length;
    this.lastTradeRef = trade.length > 0 ? trade[trade.length - 1] : null;
  }

  /** 축출 경로를 탈 수 있는가. 서면 전량 재소비로 떨어진다(정확성 우선). */
  private canEvictSafely(): boolean {
    return !this.tMsCollisionSeen;
  }

  /**
   * 이전 tail 참조가 새 배열의 어디에 있는지로 **축출량과 새 접미의 시작**을 구한다.
   *
   * 이전 배열이 `[a0..a_{L-1}]`, 새 배열이 `[a_k..a_{L-1}, …새것]` 이면 tail `a_{L-1}` 은
   * 새 배열의 `L-1-k` 에 있다 → `evicted = k`, 접미는 그 다음부터다.
   *
   * 종전엔 `ob[L-1] === lastRef` 하나만 봤다(순수 append 만 통과). 15분 슬라이딩 창은
   * **앞을 자르고 뒤에 붙이므로** 그 검사가 항상 실패했고, 매 flush 마다 전량 재소비가
   * 일어났다 — 이 함수가 그 세 번째 모양을 알아보게 한다.
   *
   * 뒤에서부터 찾는다: 정상 흐름에선 append 개수(보통 1~수 개)만에 만난다. 못 찾으면
   * O(n) 이지만 그건 폴백 경로이고 어차피 전량 재소비 O(n) 을 하게 된다.
   */
  private planSlide<T>(
    next: ReadonlyArray<T>,
    prevLength: number,
    lastRef: T | null,
  ): { evicted: number; suffixFrom: number } | null {
    if (prevLength === 0) return { evicted: 0, suffixFrom: 0 };
    if (lastRef === null) return null;
    // 순수 append 의 O(1) 지름길(종전 검사와 동일).
    if (next.length >= prevLength && next[prevLength - 1] === lastRef) {
      return { evicted: 0, suffixFrom: prevLength };
    }
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (next[i] !== lastRef) continue;
      const evicted = prevLength - 1 - i;
      if (evicted <= 0) return null;   // tail 이 뒤로 갔다 = 우리가 모르는 재배열
      return { evicted, suffixFrom: i + 1 };
    }
    return null;   // tail 이 사라졌다(종목 전환·리셋·통째 교체) → 전량 재소비
  }

  private reset(): void {
    this.events = [];
    this.eventIndexByKey = new Map();
    this.eventSeq = [];
    this.head = 0;
    this.consumedObSeq = 0;
    this.obBaseSeq = 0;
    this.touchCounts = [];
    this.touchTimes = [];
    this.touchPrices = [];
    this.touchesByWindow = new Map();
    this.extremeByWindow = new Map();
    this.tMsCollisionSeen = false;
    // `fallbacks`/`lastFallbackReason` 은 **지우지 않는다** — reset 은 누적 상태를 버리는
    // 것이지 "이 창에서 폴백이 몇 번 있었나" 라는 사실을 지우는 게 아니다.
  }

  /**
   * 진단 스냅샷. **성능 계약이 실제로 지켜지는지 장중에 확인하는 유일한 창구다.**
   *
   * `fallbacks` 가 계속 는다 = 슬라이딩이 안 먹고 매번 전량 재소비 중이다(결과는 옳지만
   * 이 최적화는 무효). `liveEvents` 가 계속 큰다 = 축출이 안 되고 있다.
   */
  diagnostics(): {
    fallbacks: number;
    lastFallbackReason: FallbackReason | null;
    liveEvents: number;
    touches: number;
  } {
    return {
      fallbacks: this.fallbacks,
      lastFallbackReason: this.lastFallbackReason,
      liveEvents: this.events.length - this.head,
      touches: this.touchTimes.length,
    };
  }

  /** 앞에서 `evicted` 개 ob 스냅샷이 창을 벗어났다 — 그 순번 이하의 이벤트를 버린다. */
  private evictOb(evicted: number): void {
    this.obBaseSeq += evicted;
    let h = this.head;
    // `eventSeq` 는 비감소라 버릴 것은 항상 prefix 다(위 필드 주석의 불변식).
    while (h < this.events.length && this.eventSeq[h] < this.obBaseSeq) h += 1;
    this.head = h;
    this.compactEvents();
  }

  /** head 가 절반을 넘으면 실제로 잘라내고 맵을 다시 만든다 — 축출당 상각 O(1). */
  private compactEvents(): void {
    if (this.head === 0 || this.head * 2 < this.events.length) return;
    this.events = this.events.slice(this.head);
    this.eventSeq = this.eventSeq.slice(this.head);
    this.eventIndexByKey = new Map();
    for (let i = 0; i < this.events.length; i += 1) {
      const event = this.events[i];
      this.eventIndexByKey.set(`${event.price}:${event.t_ms}`, i);
    }
    this.head = 0;
  }

  /** 앞에서 `evicted` 개 trade 스냅샷이 창을 벗어났다 — 그들이 기여한 터치만 버린다.
   *  시각으로 자르지 않는 이유: 아이템의 `t_ms` 는 스냅샷 시각과 다를 수 있어(폴백 규칙)
   *  "창에 남은 스냅샷의 오래된 터치" 를 잘못 버릴 수 있다. 기여 개수는 그 모호함이 없다. */
  private evictTrades(evicted: number): void {
    let drop = 0;
    for (let i = 0; i < evicted && i < this.touchCounts.length; i += 1) drop += this.touchCounts[i];
    this.touchCounts.splice(0, evicted);
    if (drop === 0) return;
    // 버려지는 prefix 가 **어느 분들에** 걸쳤는지 세어 둔다. 슬라이딩 정상상태에서는
    // 보통 가장 오래된 한 분뿐이다.
    const dropCountByWindow = new Map<number, number>();
    for (let i = 0; i < drop; i += 1) {
      const window = touchWindowOf(this.touchTimes[i]);
      dropCountByWindow.set(window, (dropCountByWindow.get(window) ?? 0) + 1);
    }
    this.touchTimes.splice(0, drop);
    this.touchPrices.splice(0, drop);
    for (const [window, count] of dropCountByWindow) {
      const prices = this.touchesByWindow.get(window);
      if (prices === undefined) continue;
      // 전체가 prefix 로 잘렸으므로 이 분 배열에서도 prefix 다(필드 주석의 도착 순 불변식).
      prices.splice(0, count);
      if (prices.length === 0) {
        this.touchesByWindow.delete(window);
        this.extremeByWindow.delete(window);
        continue;
      }
      // 극값은 삭제가 안 되는 집계라, 남은 것들로 **이 분만** 다시 잰다.
      this.extremeByWindow.set(window, this.extremeOf(prices));
    }
  }

  /** 한 분의 남은 가격들에서 극값(ask=max, bid=min). */
  private extremeOf(prices: readonly number[]): number {
    const isAsk = this.side === 'ask';
    let best = prices[0];
    for (let i = 1; i < prices.length; i += 1) {
      const price = prices[i];
      if (isAsk ? price > best : price < best) best = price;
    }
    return best;
  }

  private consumeOb(snapshots: ReadonlyArray<ObSnapshot>): void {
    for (const snapshot of snapshots) {
      const seq = this.consumedObSeq;
      this.consumedObSeq += 1;
      if (!isIndicatorEligibleBook(snapshot, this.sessionOpenMs)) continue;
      const levels = this.side === 'ask' ? snapshot.asks : snapshot.bids;
      if (!levels) continue;
      for (const level of levels) {
        if (!isFiniteNumber(level.price) || !isFiniteNumber(level.qty) || level.qty <= 0) continue;
        const key = `${level.price}:${snapshot.t_ms}`;
        const index = this.eventIndexByKey.get(key);
        // `index < head` = 축출된 죽은 슬롯. 없는 것으로 취급해야 한다 — 그 슬롯에 쓰면
        // 새 이벤트가 영영 목록에 안 들어간다(head 아래는 순회 대상이 아니다).
        if (index === undefined || index < this.head) {
          this.eventIndexByKey.set(key, this.events.length);
          this.events.push({ price: level.price, qty: level.qty, t_ms: snapshot.t_ms });
          this.eventSeq.push(seq);
          continue;
        }
        if (this.eventSeq[index] !== seq) {
          // 같은 `price:t_ms` 가 **다른 스냅샷**에서 나왔다 = t_ms 중복. 이 이벤트를
          // 어느 순번에 귀속시켜도 축출 판정이 틀릴 수 있으므로 슬라이딩을 포기한다.
          this.tMsCollisionSeen = true;
        }
        if (level.qty > this.events[index].qty) {
          this.events[index] = { price: level.price, qty: level.qty, t_ms: snapshot.t_ms };
        }
      }
    }
  }

  private consumeTrade(snapshots: ReadonlyArray<TradeSnapshot>): void {
    for (const snapshot of snapshots) {
      let contributed = 0;
      for (const item of snapshot.trades) {
        if ((item.side !== 1 && item.side !== -1) || !isFiniteNumber(item.price)) continue;
        const tMs = isFiniteNumber(item.t_ms) ? item.t_ms : snapshot.t_ms;
        if (!isFiniteNumber(tMs) || tMs <= 0) continue;
        this.touchTimes.push(tMs);
        this.touchPrices.push(item.price);
        // 삽입은 극값의 **닫힌 연산**이라 O(1) 이다 — 새 값과 기존 극값의 max/min.
        // (삭제만 재계산이 필요하고, 그건 evictTrades 가 닿은 분에만 한다.)
        const window = touchWindowOf(tMs);
        const bucket = this.touchesByWindow.get(window);
        if (bucket === undefined) {
          this.touchesByWindow.set(window, [item.price]);
          this.extremeByWindow.set(window, item.price);
        } else {
          bucket.push(item.price);
          const current = this.extremeByWindow.get(window) as number;
          const isAsk = this.side === 'ask';
          if (isAsk ? item.price > current : item.price < current) {
            this.extremeByWindow.set(window, item.price);
          }
        }
        contributed += 1;
      }
      this.touchCounts.push(contributed);
    }
  }

  private isTouched(event: AskPeakCandidate): boolean {
    const extreme = this.extremeByWindow.get(touchWindowOf(event.t_ms));
    if (extreme === undefined) return false;
    return this.side === 'ask' ? extreme >= event.price : extreme <= event.price;
  }

  private classify(extras: readonly AskPeakCandidate[]): PeakWallClassification {
    const touched: AskPeakCandidate[] = [];
    const all: AskPeakCandidate[] = [];
    const consider = (candidate: AskPeakCandidate) => {
      pushTopK(all, candidate);
      if (this.isTouched(candidate)) pushTopK(touched, candidate);
    };
    for (let i = this.head; i < this.events.length; i += 1) consider(this.events[i]);
    // extras(백엔드 피크 후보·seed)는 호출마다 달라질 수 있어 누적하지 않고 매번
    // 분류한다. 배치의 uniqueCandidates(price:qty:t_ms 키)와 동치인 중복 제거:
    // extras 상호 간 + 누적 이벤트와의 중복(같은 price:t_ms에 같은 qty)을 걸러낸다.
    const seenExtras = new Set<string>();
    for (const extra of extras) {
      const uniqKey = `${extra.price}:${extra.qty}:${extra.t_ms}`;
      if (seenExtras.has(uniqKey)) continue;
      seenExtras.add(uniqKey);
      if (this.isCoveredByLiveEvent(extra)) continue;
      consider(extra);
    }
    return { touched, all };
  }

  /**
   * 이 extra 가 **창에 살아 있는** 누적 이벤트와 같은가(= 중복이라 건너뛴다).
   *
   * ⚠ `index >= this.head` 가 이 함수의 존재 이유다. head 아래 슬롯은 축출된 이벤트인데,
   * 그걸 살아 있는 것으로 읽으면 extra 를 **잘못 건너뛴다** — 배치는 그 이벤트가 창에서
   * 사라졌으므로 extra 를 고려하므로 결과가 갈린다. 창 밖으로 밀려난 벽이 계속 보이던
   * #926 계열 실패와 같은 방향(스테일)이다.
   */
  private isCoveredByLiveEvent(extra: AskPeakCandidate): boolean {
    const index = this.eventIndexByKey.get(`${extra.price}:${extra.t_ms}`);
    if (index === undefined || index < this.head) return false;
    return this.events[index].qty === extra.qty;
  }

  /** classify 의 as-of-cutoff 판. 이벤트·extras·터치를 t_ms <= cutoffMs 로 제한한다.
   *  cutoff 는 팬으로 이동하므로 캐시하지 않고 호출마다 O(n) 으로 분 극값 맵을 다시
   *  만든다. 배치 mergedAskFamilies 의 cutoff 분기와 동일: cutoff 이하 터치로만 벽의
   *  touched 여부를 재평가한다(경계 분은 부분만 반영된다 — 그게 "그 시각까지 본 것"
   *  이라는 cutoff 의 의미다). no-cutoff classify 의 dedup·top-3 규칙을 그대로 상속. */
  private classifyAsOf(
    extras: readonly AskPeakCandidate[],
    cutoffMs: number,
  ): PeakWallClassification {
    const isAsk = this.side === 'ask';
    const extremeByWindow = new Map<number, number>();
    for (let i = 0; i < this.touchTimes.length; i += 1) {
      const tMs = this.touchTimes[i];
      if (tMs > cutoffMs) continue;
      const window = touchWindowOf(tMs);
      const current = extremeByWindow.get(window);
      const price = this.touchPrices[i];
      extremeByWindow.set(
        window,
        current === undefined ? price : (isAsk ? Math.max(current, price) : Math.min(current, price)),
      );
    }
    const isTouchedC = (event: AskPeakCandidate): boolean => {
      const extreme = extremeByWindow.get(touchWindowOf(event.t_ms));
      if (extreme === undefined) return false;
      return isAsk ? extreme >= event.price : extreme <= event.price;
    };
    const touched: AskPeakCandidate[] = [];
    const all: AskPeakCandidate[] = [];
    const consider = (candidate: AskPeakCandidate) => {
      if (candidate.t_ms > cutoffMs) return;
      pushTopK(all, candidate);
      if (isTouchedC(candidate)) pushTopK(touched, candidate);
    };
    for (let i = this.head; i < this.events.length; i += 1) consider(this.events[i]);
    const seenExtras = new Set<string>();
    for (const extra of extras) {
      if (extra.t_ms > cutoffMs) continue;
      const uniqKey = `${extra.price}:${extra.qty}:${extra.t_ms}`;
      if (seenExtras.has(uniqKey)) continue;
      seenExtras.add(uniqKey);
      if (this.isCoveredByLiveEvent(extra)) continue;
      consider(extra);
    }
    return { touched, all };
  }
}

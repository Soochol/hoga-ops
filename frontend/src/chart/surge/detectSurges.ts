import type { QuoteRatioPoint } from '../../api/types';
import { tradingDayOf } from '../../util/tradingDay';

export type SurgeSide = 'ask' | 'bid';
/** prevPeak = 발사 시점의 running peak(직전 고가). value = 그 순간 총잔량. pctOfPeak = value/prevPeak
 *  (근접 발사면 0.95~1.0, 신고가 갱신 중이면 ≥1.0). */
export type SurgeMarker = { t: number; prevPeak: number; value: number; pctOfPeak: number };

export type DetectSurgesOpts = {
  /** 근접 발사 문턱(비율): value ≥ approachRatio × runningPeak 이면 발사. 기본 0.95. */
  approachRatio: number;
  /** 재무장 문턱(비율): value < rearmRatio × runningPeak 로 빠지면 다시 발사 가능. 기본 0.85.
   *  (히스테리시스 — 고점 근처 출렁임에 도배되지 않게 approachRatio보다 낮게.) */
  rearmRatio: number;
  /** 마감 동시호가(15:20–15:30) 구간 술어. true면 발사·peak갱신 모두 제외. */
  isClosingAuction: (t: number) => boolean;
  /** 호가단위 보정(선택). 사다리의 **호가단위(`tick`)가 바뀐 시점**에 running peak 을
   *  틱 비율로 환산한다. 값은 **확인 게이트의 문턱**(사다리 폭이 이 비율 이상 실제로
   *  움직였을 때만 환산). `undefined` = 보정 없음(기본 동작 그대로).
   *
   *  왜 필요한가: 총잔량은 "고정된 가격 폭"이 아니라 "고정된 호가 단계 수"로 잰 값이다.
   *  KRX 호가단위가 가격대별 계단함수라 2,000·5,000·20,000·50,000·200,000·500,000원
   *  경계를 지나면 10호가가 덮는 가격 폭이 2~5배 점프하고, 물량이 늘지 않아도 총잔량이
   *  같은 배수로 뛴다. 그러면 "오전에 좁은 자로 잰 최고치"와 "오후에 넓은 자로 잰 값"을
   *  비교하게 된다 — 실측 오발률이 기저의 2.9배였다.
   *
   *  **트리거가 폭이 아니라 틱인 이유**(ADR-0151 Amendment 2): 폭은 `틱 × 빈 호가 배수`
   *  라 잡음이 곱해져 있다. 폭 25% 문턱으로 하면 환산이 하루 중앙 12회·최대 140회 나는데
   *  실제 호가단위 변화는 하루 두세 번이다. 틱은 가격의 결정론적 함수라 잡음이 없다.
   *
   *  **확인 게이트가 거부권만 갖는 이유**: 잡음이 환산을 *일으킬* 수 있으면 안 된다.
   *  ETF 는 틱이 5원 고정이라 표가 "바뀌었다" 해도 사다리 폭이 안 움직인다 — 그때
   *  거부한다. 실측(경계 통과 108 종목일 / 미통과 242 종목일):
   *
   *  | 안 | 경계일 오발 | 환산/일 중앙 | 비경계일 보존 |
   *  |---|---|---|---|
   *  | 없음 | 2.9배 | 0 | 100% |
   *  | 폭 25% 문턱(구안) | 2.0배 | 12 | 90.6% |
   *  | 표 트리거 + 확인 10% | **1.7배** | 4 | **100.0%** |
   *
   *  보존율 100% 는 통계가 아니라 **구조적**이다 — 틱이 안 변하면 이 분기가 아예 안 돈다. */
  tickConfirmRatio?: number;
};

const FIELD: Record<SurgeSide, 'ask_total' | 'bid_total'> = { ask: 'ask_total', bid: 'bid_total' };

// 거래일(세션) 경계 = KST 자정. running peak를 거래일마다 0으로 리셋한다. 세션은 09:00–15:30라
// 한 거래일이 한 KST 날짜에 들어가므로 "KST 날짜 변화 = 세션 경계". sessionOpens를 따로 받지 않고
// 점의 t에서 직접 도출 → 한 청크(과거/당일 어느 쪽이든) 안에서 자기-완결적으로 리셋된다. 이 self-reset
// 덕분에 각 거래일 마커는 그 거래일 점에만 의존 → makePastCachedProjector의 `cachedPast ++ today === all`
// 불변식이 그대로 성립(과거 동결 + 당일만 재계산). 거래일 번호는 util/tradingDay에 공유
// (당일 매도 최대벽 래칫과 동일 기준 — 경계 규칙 단일 출처).

/**
 * 한 side(ask|bid)의 급증 마커 — **근접(re-approach) + 히스테리시스 + 꼭대기 추적** 방식.
 * 벽이 당일 running peak의 `approachRatio`(기본 95%)까지 차오르면 1회 발사하고, `rearmRatio`(기본 85%)
 * 아래로 빠져야 다시 발사 가능. 즉 "벽이 자기 직전 고가에 다시 도전하는 순간"을 한 번씩 잡는다.
 * **꼭대기 추적**: 한 번 발사한 뒤(disarm) 재무장 전까지 더 큰 신고가가 계속 나오면, 그 마커를 새 꼭대기
 * 봉으로 *이동*시킨다 — 단조 상승 구간에서 동그라미가 "첫 돌파 봉"이 아니라 "그 구간의 최종 꼭대기"에
 * 자리잡게 한다(첫 돌파 봉에 찍고 disarm되어 진짜 꼭대기를 놓치던 동작을 교정). `rearmRatio` 아래로
 * 빠지면 사이클 종료 → 다음 발사는 새 마커.
 * 거래일마다 running peak·무장·활성마커 리셋, 마감 동시호가 제외. quiet-start: 무장은 false로 시작
 * (첫 고가가 세워지고 한 번 빠진 뒤부터 발사 — 비교할 직전 고가가 생긴 뒤).
 */
export function detectSurgeSide(
  points: readonly QuoteRatioPoint[],
  side: SurgeSide,
  o: DetectSurgesOpts,
): SurgeMarker[] {
  const out: SurgeMarker[] = [];
  let runningMax = 0;
  // 호가단위 보정의 기준(틱·폭). runningMax 와 **같은 자리에서** 거래일마다 리셋해야
  // `cachedPast ++ today === all` (Past/Today Split Cache 바이트 동일성)이 유지된다 —
  // 하루 밖의 기준을 물고 들어오면 today 청크가 과거 거래일 결과를 바꾼다.
  let tickRef: number | null = null;
  let widthRef = 0;
  let armed = false;
  // 현재 발사 사이클의 마커 인덱스(-1 = 사이클 없음). disarm 상태에서 신고가 갱신 시 이 마커를 이동.
  // 거래일 경계에서 -1로 리셋 → today 청크가 과거 거래일 마커를 건드리지 않아 Split Cache 불변식
  // (cachedPast ++ today === all)이 유지된다.
  let activeIdx = -1;
  let curDay = Number.NaN;
  for (const p of points) {
    const day = tradingDayOf(p.t);
    if (day !== curDay) {
      curDay = day;
      runningMax = 0; // 거래일 경계 리셋
      tickRef = null;
      widthRef = 0;
      armed = false;
      activeIdx = -1;
    }
    if (o.isClosingAuction(p.t)) continue; // 마감 동시호가 누적 제외
    const v = p[FIELD[side]];
    // 호가단위 보정: 자가 바뀌었으면 running peak 을 새 자 단위로 환산한다.
    // tick = 0 은 "틱이 0" 이 아니라 **"모름"**이다(동시호가 등) — 건너뛰고 기준도
    // 갱신하지 않는다. 0 을 기준으로 받으면 다음 실측에서 배율이 Infinity 가 된다.
    const tk = p.tick;
    if (o.tickConfirmRatio !== undefined && tk > 0) {
      if (tickRef === null) {
        tickRef = tk;
        widthRef = p.band_pct;
      } else if (tk !== tickRef) {
        // 확인 게이트 — **거부권만** 갖는다. 사다리 폭이 실제로 움직이지 않았으면
        // (ETF 처럼 표가 틀리는 종목군) 환산하지 않는다. 폭을 못 재면(0) 확인할
        // 방법이 없으므로 역시 환산하지 않는다 — 모르면 건드리지 않는 쪽.
        const w = p.band_pct;
        if (widthRef > 0 && w > 0 && Math.abs(w / widthRef - 1) >= o.tickConfirmRatio) {
          runningMax *= tk / tickRef;
        }
        tickRef = tk;
        widthRef = w;
      }
    }
    if (runningMax > 0) {
      if (v < o.rearmRatio * runningMax) {
        armed = true; // 빠짐 → 재무장
        activeIdx = -1; // 사이클 종료 — 다음 발사는 새 마커
      }
      if (armed && v >= o.approachRatio * runningMax) {
        out.push({ t: p.t, prevPeak: runningMax, value: v, pctOfPeak: v / runningMax });
        activeIdx = out.length - 1;
        armed = false; // 한 번 발사 후 disarm (재무장 전까지 도배 방지)
      } else if (activeIdx >= 0 && v > runningMax) {
        // 발사 후(disarm) 재무장 전까지 진짜 신고가 → 마커를 이 꼭대기로 이동.
        // prevPeak는 발사 시점 직전 고가를 유지(pctOfPeak = 꼭대기/발사직전고가, 미표시 데이터 — #83).
        const prevPeak = out[activeIdx].prevPeak;
        out[activeIdx] = { t: p.t, prevPeak, value: v, pctOfPeak: v / prevPeak };
      }
    }
    if (v > runningMax) runningMax = v; // 래칫
  }
  return out;
}

/** 양 side를 함께 산출(직접 호출·테스트용). 캐시 경로는 side별 detectSurgeSide를 따로 쓴다(중복 계산 회피). */
export function detectSurges(
  points: readonly QuoteRatioPoint[],
  opts: DetectSurgesOpts,
): Record<SurgeSide, SurgeMarker[]> {
  return { ask: detectSurgeSide(points, 'ask', opts), bid: detectSurgeSide(points, 'bid', opts) };
}

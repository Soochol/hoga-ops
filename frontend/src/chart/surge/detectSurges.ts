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
  /** 호가단위 보정(선택). 사다리 폭(`band_pct`)이 직전 기준 대비 이 비율을 넘게 바뀌면
   *  running peak 을 **폭비로 환산**한다. `undefined` = 보정 없음(기본 동작 그대로).
   *
   *  왜 필요한가: 총잔량은 "고정된 가격 폭"이 아니라 "고정된 호가 단계 수"로 잰 값이다.
   *  KRX 호가단위가 가격대별 계단함수라 2,000·5,000·20,000·50,000·200,000·500,000원
   *  경계를 지나면 10호가가 덮는 가격 폭이 2~5배 점프하고, 물량이 늘지 않아도 총잔량이
   *  같은 배수로 뛴다. 그러면 "오전에 좁은 자로 잰 최고치"와 "오후에 넓은 자로 잰 값"을
   *  비교하게 된다 — 실측 오발률이 기저의 3.4배였다.
   *
   *  왜 곱이 아니라 환산인가: 이 검출기는 **상대 비교**(`v ≥ approach × peak`)라
   *  시리즈 전체를 같은 수로 나누면 아무것도 안 바뀐다. 나누기가 효과를 내는 순간은
   *  폭이 변한 때뿐이므로, `총잔량 ÷ 폭` 과 `peak × 폭비` 는 같은 교정이다. 후자를
   *  택한 이유는 **표시값을 건드리지 않기 때문**이다.
   *
   *  왜 문턱이 있는가: 사다리 폭은 빈 호가 탓에 분마다 출렁인다(저가주는 19~30틱을
   *  오간다). 매 분 환산하면 그 흔들림이 섞여 경계와 무관한 날의 마커 19% 가 달라졌다.
   *  0.25 에서 교정력은 유지하면서(기저 대비 3.4배 → 2.0배) 보존율이 92.9% 였다.
   *  근거·실측: `docs/research/2026-08-19-hoga-tick-band-totals-normalization.md`. */
  widthStepRatio?: number;
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
  // 호가단위 보정의 기준 폭. runningMax 와 **같은 자리에서** 거래일마다 리셋해야
  // `cachedPast ++ today === all` (Past/Today Split Cache 바이트 동일성)이 유지된다 —
  // 하루 밖의 폭을 물고 들어오면 today 청크가 과거 거래일 결과를 바꾼다.
  let widthRef: number | null = null;
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
      widthRef = null;
      armed = false;
      activeIdx = -1;
    }
    if (o.isClosingAuction(p.t)) continue; // 마감 동시호가 누적 제외
    const v = p[FIELD[side]];
    // 호가단위 보정: 자가 바뀌었으면 running peak 을 새 자 단위로 환산한다.
    // band_pct = 0 은 "폭이 0" 이 아니라 **"폭을 잴 수 없음"**이다(동시호가·3단 붕괴
    // 사다리는 ask_p10 이 0이라 폭이 정의되지 않는다) — 그런 점은 보정에서 제외하고
    // 기준 폭도 갱신하지 않는다. 0 을 폭으로 받아들이면 나눗셈이 폭발한다.
    const w = p.band_pct;
    if (o.widthStepRatio !== undefined && w > 0) {
      if (widthRef === null) {
        widthRef = w;
      } else if (Math.abs(w / widthRef - 1) > o.widthStepRatio) {
        runningMax *= w / widthRef;
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

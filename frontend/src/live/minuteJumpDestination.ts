/**
 * 「분봉으로」의 **목적지 판정** — 어느 날로 가는가, 그리고 갈 수 있는가.
 *
 * 소비자가 둘이라 따로 뗀다: 헤더 버튼(호버 미리보기 + 클릭)과 `g` 단축키. 둘이
 * 각자 판정하면 **버튼은 막았는데 단축키는 보내는** 상태가 생기고, 그 어긋남은
 * 화면에 안 보인다(눌러 보기 전엔 모른다).
 *
 * 컴포넌트 파일이 아니라 여기 있는 이유는 react-refresh 규약이다 — 이 리포는 훅·
 * 순수 함수와 컴포넌트를 한 파일에 섞지 않는다(`windowViewContext.ts` 의 그 절).
 */
import { realMsToYyyymmdd } from './liveDateTime';
import { savedRangeAnchorTs } from './savedRangeAnchor';
import type { CalendarTimeframe } from '../state/livePage';

/**
 * 「분봉으로」의 목적지 봉 — **이 창에서 보이는 가장 오른쪽 캔들**의 실시각.
 *
 * 규칙은 이것 하나다(2026-08-22 사용자 결정). 한때 「마지막으로 호버한 봉이 화면
 * 안이면 그것」이 앞에 있었으나 걷어냈다 — 같은 화면에서 같은 버튼을 눌러도 마우스가
 * 그 사이 어디를 지나갔는지에 따라 목적지가 달라져, 툴팁 미리보기가 편의가 아니라
 * **필수**였다. 지금은 "일봉 오른쪽 끝 = 분봉 오른쪽 끝" 한 문장으로 끝난다.
 *
 * `visibleToMs` 를 그대로 쓰지 않고 **그 이하의 마지막 실재 캔들**로 내리는 이유는
 * 저장뷰 앵커와 같다: 우측 여백을 보고 있으면 그 시각의 봉이 없다. 그때 목적지는
 * 최신 캔들이 되고, 그것이 「보이는 가장 오른쪽 캔들」의 정의와도 맞는다.
 *
 * ⚠ **폴백이 둘이고 방향이 반대다.** 이 구별을 뭉개면 "과거를 보려고 팬했는데 오늘로
 * 끌려가는" 정반대 동작이 된다(테스트가 실제로 그렇게 잡았다):
 *
 * - **측정 불가**(`visibleToMs === null` · 차트가 아직 안 섬) → **최신 캔들**.
 *   화면을 모르는 상태라 안전한 기본값이 라이브 엣지다.
 * - **측정됐는데 그 이하에 봉이 없다**(뷰 전체가 데이터보다 **과거** — 좌측 여백만
 *   보는 중) → **첫 캔들**. 사용자는 가장 과거 쪽을 보고 있고, 그 의도에 가장 가까운
 *   실재 봉이 데이터의 왼쪽 끝이다. 여기서 최신으로 보내면 팬한 방향의 반대다.
 *
 * 좌표를 읽는 일(`getVisibleRange` · 축 변환)은 호출부에 남는다 — 여기 있는 것은
 * **규칙**이라 차트 없이 테스트된다.
 *
 * @param candles ts 오름차순. 비어 있으면 null(그릴 것이 없다).
 * @param visibleToMs 뷰 우측 끝의 실시각. 측정 불가면 null.
 */
export function jumpTargetMs(
  candles: readonly { ts_ms: number }[],
  visibleToMs: number | null,
): number | null {
  if (candles.length === 0) return null;
  if (visibleToMs === null || !Number.isFinite(visibleToMs)) {
    return candles[candles.length - 1].ts_ms;
  }
  return savedRangeAnchorTs(candles, visibleToMs) ?? candles[0].ts_ms;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 캘린더 봉 한 칸이 **덮는 마지막 순간**(포함 상한). 소비 창은 이 값 **이하의 마지막
 * 봉**에 앉으므로, 이것이 곧 「그 칸의 마지막 거래일 마지막 봉」을 고르는 규칙이 된다.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────
 * 캘린더 봉의 `ts_ms` 는 그 칸의 **시작**이다. 그것을 그대로 목적지로 넘기면 주·월봉에서
 * 칸의 **첫** 거래일로 간다 — 실측(2026-08-23, 005930): 주봉 `08-18`, 월봉 `08-03`.
 * 최신 봉을 보고 있는데도 그렇게 떨어져 월봉은 **3주**가 어긋났다. 일봉은 칸이 하루라
 * 우연히 맞았을 뿐이고, "일봉 오른쪽 끝 = 분봉 오른쪽 끝" 이라는 결정(2026-08-22)의
 * 주·월봉 대응물이 여기다.
 *
 * ── 왜 「다음 봉 ts − 1」 이 아닌가 ───────────────────────────────────────
 * 세 가지가 다 걸린다. ① 일봉에서 다음 봉은 **다음 거래일**이라 금요일 봉의 상한이
 * 일요일이 되고, 진행 중인 점프의 칩이 주말 날짜를 말한다(지금은 금요일 그대로다).
 * ② 주봉은 **첫 거래일**에 앵커되므로(위 08-18 = 화요일, 08-17 이 대체공휴일) `anchor +
 * 7일` 이 다음 주 월요일로 넘친다. ③ 마지막 봉은 다음 봉이 아예 없다. 달력으로 풀면
 * 셋 다 사라진다.
 *
 * `nowMs` 로 자르는 이유는 ③ 의 나머지 절반이다 — 진행 중인 칸의 상한은 아직 미래이고,
 * 미래를 상한으로 주면 그 칸의 「마지막 봉」이 라이브 엣지가 된다(그게 맞다).
 *
 * ⚠ **거래일 달력을 쓰지 않는다.** 상한은 달력상의 칸 끝이고, 그 칸의 마지막 *거래일*을
 * 고르는 일은 **분봉 창이 자기 캔들로** 한다. 발행 창에는 거래일 정보가 없고, 하드코딩된
 * 근사를 여기 두면 휴일마다 어긋난다.
 */
export function bucketEndMs(
  tf: CalendarTimeframe,
  anchorTs: number,
  nowMs: number,
): number {
  const date = realMsToYyyymmdd(anchorTs);
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  // KST 자정 = 그 날 00:00 KST 의 Unix ms. `Date.UTC` 는 UTC 자정이므로 9시간 당긴다.
  const kstMidnight = (yy: number, mm: number, dd: number) =>
    Date.UTC(yy, mm - 1, dd) - KST_OFFSET_MS;

  let exclusiveEnd: number;
  if (tf === 'M') {
    exclusiveEnd = kstMidnight(y, m + 1, 1); // 다음 달 1일 00:00 KST (m 은 1-based)
  } else if (tf === 'W') {
    // 그 주 일요일의 다음 날 00:00 KST. `getUTCDay()` 는 0=일요일.
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    exclusiveEnd = kstMidnight(y, m, d + ((7 - dow) % 7) + 1);
  } else {
    exclusiveEnd = kstMidnight(y, m, d + 1);
  }
  return Math.min(exclusiveEnd - 1, nowMs);
}

/**
 * 「분봉으로」가 발행하는 **구간** — 어느 칸을 여는가.
 *
 * `fromMs` 는 칸의 시작(= 보이는 가장 오른쪽 캔들의 `ts_ms`), `toMs` 는 그 칸의 포함
 * 상한이다. 소비 창이 둘을 **다른 일에** 쓰기 때문에 하나로 합칠 수 없다:
 *
 * - `toMs` — **착지**. 이 값 이하의 마지막 봉에 앉는다.
 * - `fromMs` — **백필**. 그 창이 과거로 채워야 할 시작일이다. 여기에 `toMs` 를 쓰면
 *   로드 구간이 `[칸 끝, 지금]` 이 되어 **착지 대상인 그 칸의 봉이 영영 안 온다**
 *   (먼 과거 주·월봉이 영원히 「불러오는 중」에 머문다).
 *
 * 캔들이 없으면 null. 폴백 두 갈래(측정 불가 → 최신 / 좌측 여백 → 첫 봉)는
 * `jumpTargetMs` 가 갖는다.
 */
export type JumpRange = {
  /** 칸의 시작 — 백필 목표. */
  fromMs: number;
  /** 칸의 포함 상한 — 착지 기준. */
  toMs: number;
};

export function jumpPublicationRange(
  candles: readonly { ts_ms: number }[],
  visibleToMs: number | null,
  tf: CalendarTimeframe,
  nowMs: number,
): JumpRange | null {
  const fromMs = jumpTargetMs(candles, visibleToMs);
  if (fromMs === null) return null;
  return { fromMs, toMs: bucketEndMs(tf, fromMs, nowMs) };
}

export type JumpDestination = {
  /** 목적지 YYYYMMDD(KST). */
  date: string;
  /**
   * 그 분봉 창의 **좌측 팬 하한 밖** — 백필해도 빈 응답만 온다.
   *
   * ⚠ **하한을 여기서 계산하지 않고 받는다.** 종전엔
   * `earliestAllowedMinuteDate(todayKstYyyymmdd())` 를 직접 불렀는데, 그건 **벤더
   * 엔드포인트의 span 캡**(250일)이라 디스크(hogaplay)를 읽는 창에는 근거가 없다 —
   * 그 창은 캡처가 있는 만큼 더 과거를 볼 수 있고, 하드코딩된 벽은 **볼 수 있는
   * 구간을 못 본다고 말하는 안내**가 된다(`savedRangeNotice` 헤더가 경고한 그것).
   *
   * 하한이 모드에 따라 갈리는 값이 된 이상 판정은 모드를 아는 쪽이 해야 한다 —
   * `useLiveBundle.minuteScrollbackFloorDate`(#1497 이 같은 이유로 백필에서 옮긴 값).
   * 그래서 이 판정도 **분봉 창에서만** 성립한다: 일봉 창은 그 값이 항상 `null` 이다.
   */
  outOfRetention: boolean;
};

/**
 * 실시각 → 목적지 판정. 값이 없거나 유한하지 않으면 null.
 *
 * @param floorDate 그 창의 좌측 팬 하한(YYYYMMDD). `null` = 무한(디스크 모드·미측정)
 *   이라 **막지 않는다** — 모르는 것을 못 간다고 말하지 않는다.
 */
export function jumpDestinationOf(
  toMs: number | null,
  floorDate: string | null,
): JumpDestination | null {
  if (toMs === null || !Number.isFinite(toMs)) return null;
  const date = realMsToYyyymmdd(toMs);
  return { date, outOfRetention: floorDate !== null && date < floorDate };
}

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

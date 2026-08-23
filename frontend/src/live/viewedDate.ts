/**
 * 분봉 창이 **지금 어느 날을 보고 있는가** — 화면 상태를 말하는 규칙.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────
 * 분봉 시간축은 하루 안에서 `11:00 12:00 …` 만 찍고 **날짜는 날 경계에만** 찍는다
 * (`tickMarkFormatter` 의 `DayOfMonth` 티어). 그래서 화면이 하루 안에 들어오면 그 날이
 * 며칠인지 **차트 어디에도 없다** — 실측(2026-08-23) 스크린샷의 시간축은
 * `12:00 13:00 14:00` 뿐이었다.
 *
 * 점프 칩이 대신해 주지 않는다. 그것은 **명령**(어디로 보냈는가)이고 이것은 **화면
 * 상태**(지금 무엇이 보이는가)다 — 착지한 뒤 사용자가 팬하면 둘은 정당하게 갈라지고,
 * 칩은 × 로 풀거나 새 명령이 오면 사라진다.
 *
 * ── 판정: 오른쪽 끝 봉의 날짜가 **마지막 봉의 날짜와 다른가** ────────────
 * 「오늘과 다른가」가 아니다. 주말·장 마감 뒤에는 라이브 엣지에 있어도 화면 날짜가
 * 오늘이 아니고, 그러면 칩이 **아무것도 알려 주지 않으면서 상시 표시**된다.
 * 데이터의 끝(= 라이브 엣지)에 있으면 숨기는 것이 옳다.
 *
 * 오른쪽 끝을 쓰는 것은 이 리포의 앵커 규약이다(2026-08-22 사용자 결정 — 저장뷰
 * 착석·「분봉으로」 목적지가 모두 그 축이다). 화면이 여러 날에 걸쳐도 답은 하나다.
 *
 * `savedRangeAnchorTs` 로 **그 이하의 마지막 실재 봉**을 고르므로 우측 여백을 보고
 * 있어도(그 시각엔 봉이 없다) 마지막 봉으로 떨어져 라이브 엣지 판정이 성립한다 —
 * `getVisibleRange()` 가 오른쪽을 클램프하든 안 하든 결과가 같다.
 */
import { realMsToYyyymmdd } from './liveDateTime';
import { savedRangeAnchorTs } from './savedRangeAnchor';

/**
 * 이 화면이 말할 날짜(YYYYMMDD). **말할 것이 없으면 `null`** — 라이브 엣지에 있거나,
 * 캔들이 없거나, 뷰 전체가 데이터보다 과거(좌측 여백만)라 오른쪽 끝 봉이 없을 때다.
 *
 * @param candles ts 오름차순.
 * @param visibleToMs 뷰 우측 끝의 실시각. 측정 불가면 null.
 */
export function viewedDateOf(
  candles: readonly { ts_ms: number }[],
  visibleToMs: number | null,
): string | null {
  if (candles.length === 0) return null;
  if (visibleToMs === null || !Number.isFinite(visibleToMs)) return null;
  const anchorTs = savedRangeAnchorTs(candles, visibleToMs);
  if (anchorTs === null) return null;
  const date = realMsToYyyymmdd(anchorTs);
  return date === realMsToYyyymmdd(candles[candles.length - 1].ts_ms) ? null : date;
}

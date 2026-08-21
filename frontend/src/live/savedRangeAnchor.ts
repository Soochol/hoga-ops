/**
 * 분봉 **저장뷰 착석 앵커** — 저장 구간 끝(B)을 화면 오른쪽 끝에 놓기 위한 좌표 재료.
 *
 * `/study` 는 번들을 저장 구간으로 **클립**해서 같은 결과를 얻지만 `/live` 는 그럴 수
 * 없다 — 같은 차트가 실시간 스트림을 받고 있어 클립하면 라이브 틱이 갈 곳을 잃는다.
 * 그래서 데이터가 아니라 **뷰포트**를 옮긴다.
 *
 * ⚠ **여기는 이동만 담당하고 아무것도 막지 않는다.** 한때 같은 자리에 "B 오른쪽으로
 * 못 나가게" 하는 벽이 있었으나 2026-08-21 사용자 결정으로 제거됐다(#1457). 착석은
 * 그 뒤 다시 요청돼 돌아왔고(#1461), 지금 계약은 **데려다주되 가두지 않는다** 이다.
 * 스냅백 구독을 되살리지 말 것 — 벽은 의도적으로 없는 것이지 빠뜨린 것이 아니다.
 */

/**
 * 저장 구간 끝(B)에 해당하는 캔들의 **실시각(ts_ms)**. 구간에 봉이 하나도 없으면 null
 * (= 아직 백필이 거기까지 안 왔다는 뜻이므로 호출부는 다음 커밋에 다시 본다).
 *
 * ⚠ **논리 인덱스가 아니라 ts 를 돌려주는 것이 계약이다.** 배열 인덱스를 lwc 논리
 * 좌표로 그대로 쓰면 **어긋난다** — `/live` 차트에는 Auction Mask 등이 넣는
 * `WhitespaceData` 가 섞여 lwc 가 든 포인트 수가 `candles.length` 보다 많다. 호출부가
 * 이 ts 를 `timeScale.timeToIndex(realMsToVirtualSeconds(axis, ts), true)` 로 바꿔야
 * 한다(`LiveChartRoot` 의 다른 좌표 변환이 전부 그 경로다). 2026-08-21 실측: 배열
 * 인덱스를 그대로 썼더니 앵커가 저장 끝(06-26)이 아니라 06-29 에 섰다.
 *
 * `toMs` 를 그대로 쓰지 않고 **실재하는 캔들**로 내리는 이유는 `studySavedRangeMarks`
 * 와 같다(#1238). `toMs` **이하의 마지막 캔들**을 고른다: B 가 장 마감 후 시각이거나
 * 휴장일이면 그 시각의 봉이 없고, 그때 앵커는 그 직전 봉이어야 한다.
 *
 * 캔들은 ts 오름차순이므로 이진 탐색이다 — 딥 팬 뒤 배열이 수만 개가 된다.
 */
export function savedRangeAnchorTs(
  candles: readonly { ts_ms: number }[],
  toMs: number,
): number | null {
  let lo = 0;
  let hi = candles.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ts = candles[mid]?.ts_ms;
    if (ts === undefined) break;
    if (ts <= toMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 ? (candles[found]?.ts_ms ?? null) : null;
}

/**
 * 저장 구간 안에 실재하는 봉 수 — 착석 span 의 **폴백**.
 *
 * 저장 `bar_span` 을 못 쓰는 경우(창의 봉 ≠ 저장 당시 봉)에 쓴다. bar_span 은 봉의
 * **개수**라 봉 종류에 상대적이다 — 5m 로 저장한 300봉을 1m 창에 그대로 적용하면 같은
 * 수가 1/5 기간이 된다. `/study` 도 같은 이유로 봉이 일치할 때만 저장 뷰포트를 쓴다
 * (`StudyPage` 의 `model.save.timeframe === spec.save?.timeframe`).
 */
export function countBarsInRange(
  candles: readonly { ts_ms: number }[],
  fromMs: number,
  toMs: number,
): number {
  let n = 0;
  for (const c of candles) {
    if (c.ts_ms >= fromMs && c.ts_ms <= toMs) n += 1;
    else if (c.ts_ms > toMs) break;
  }
  return n;
}

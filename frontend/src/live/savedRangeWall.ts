/**
 * 분봉 **저장뷰 우측 벽** — 저장 구간의 끝(B)보다 오른쪽으로 못 나가게 막는 계산.
 *
 * `/study` 는 같은 것을 **번들 클립**으로 달성한다(저장 구간 밖 캔들이 애초에 없다).
 * `/live` 는 그 방법을 쓸 수 없다 — 같은 차트가 실시간 스트림을 받고 있고, 클립하면
 * 라이브 틱이 갈 곳을 잃는다. 그래서 데이터가 아니라 **뷰포트**를 막는다.
 *
 * ⚠ **막아야 할 입력이 둘이다.** 휠은 `LiveChartRoot` 가 이미 커스텀으로 소유하지만
 * (`handleScale.mouseWheel: false`), 드래그·트랙패드 팬은 여전히 lightweight-charts
 * 소유(`handleScroll`)라 구독 스냅백이 따로 필요하다. 하나만 하면 휠로는 막히는데
 * 드래그로는 나가는 **반쪽 락**이 된다.
 *
 * ⚠ **벽 인덱스를 캐시하지 말 것.** 저장뷰 적용은 과거 백필(`extend`)을 스스로
 * 발화하고, prepend 가 착지하면 기존 봉의 logical index 가 전부 밀린다
 * (`viewportAnchor.ts` 의 "bar indices are NOT stable"). 캐시하면 백필이 한 번
 * 착지할 때마다 벽이 조용히 어긋난다 — 매 이벤트 `savedRangeWallBarIndex` 로 다시
 * 구해야 한다.
 */
import { minuteRightOffsetBars } from './minuteViewportPolicy';

export type LogicalRangeLike = { from: number; to: number };

/**
 * 저장 구간 끝(B)에 해당하는 캔들의 **논리 인덱스**. 구간 안에 봉이 하나도 없으면 null.
 *
 * `toMs` 를 그대로 좌표로 바꾸지 않고 **실재하는 캔들**로 내리는 이유는
 * `studySavedRangeMarks` 와 같다 — 축에 없는 임의 ms 는 좌표가 어긋난다(#1238).
 * 여기서는 `toMs` **이하의 마지막 캔들**을 고른다: B 가 장 마감 후 시각이거나
 * 휴장일이면 그 시각의 봉이 없고, 그때 벽은 그 직전 봉이어야 한다.
 *
 * 캔들은 ts 오름차순이므로 이진 탐색이다 — 딥 팬 뒤 배열이 수만 개가 되고 이 함수는
 * **뷰포트 이벤트마다** 불린다(위 캐시 금지 주석).
 */
export function savedRangeWallBarIndex(
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
  return found >= 0 ? found : null;
}

/**
 * 가시 범위의 우측 상한(논리 좌표). 벽 봉 자체가 오른쪽 끝에 딱 붙으면 가격축 라벨
 * 거터에 가려 읽히지 않으므로, 분봉 기본 거터(`minuteRightOffsetBars`)만큼 띄운다 —
 * 라이브 엣지에서 최신 봉이 라벨에 안 가리는 것과 같은 규칙을 저장뷰 끝에 적용한다.
 */
export function savedRangeWallLimit(
  wallBarIndex: number,
  visibleBars: number,
  plotWidth: number,
): number {
  return wallBarIndex + minuteRightOffsetBars(visibleBars, plotWidth);
}

/**
 * 범위를 벽 안으로 민다. **span 은 보존한다** — 줌을 건드리지 않고 위치만 되돌리는
 * 것이 "오른쪽으로 못 나간다" 의 정확한 의미다. span 을 줄이면 사용자가 벽에 닿을
 * 때마다 화면이 조금씩 확대돼 팬이 줌으로 새어 나간다.
 *
 * @returns 이미 벽 안이면 `null` — 호출부는 그때 `setVisibleLogicalRange` 를
 *   **건너뛰어야 한다**. 무조건 쓰면 구독 콜백이 자기 쓰기로 재진입해 루프가 된다.
 */
export function clampLogicalRangeToWall(
  range: LogicalRangeLike,
  limit: number,
): LogicalRangeLike | null {
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return null;
  if (range.to <= limit) return null;
  const span = Math.max(1, range.to - range.from);
  return { from: limit - span, to: limit };
}

/**
 * 저장 구간 안에 실재하는 봉 수 — 분봉 착석의 **span 폴백**.
 *
 * 저장 `bar_span` 을 못 쓰는 경우(창의 봉 ≠ 저장 당시 봉)에 쓴다. bar_span 은 봉의
 * **개수**라 봉 종류에 상대적이다 — 5m 로 저장한 300봉을 1m 창에 그대로 적용하면
 * 같은 수가 1/5 기간이 된다. `/study` 도 같은 이유로 봉이 일치할 때만 저장 뷰포트를
 * 쓴다(`StudyPage` 의 `model.save.timeframe === spec.save?.timeframe`).
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

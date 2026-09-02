/**
 * 저장뷰 행 → `/live` 기간 슬롯 변환.
 *
 * **방향이 요점이다.** `state/livePage` 는 저장뷰를 모른다 — `api/studyViews` 가
 * 거기서 `LiveTimeframe` 을 import 하므로 역방향은 순환이다. 그래서 슬롯은 원시
 * 필드로 평탄화돼 있고(`SavedRangeFocus`), 변환은 저장뷰를 아는 이쪽이 한다.
 *
 * 슬롯이 저장뷰의 **부분집합**인 것도 의도다. 메모·태그·타임스탬프는 `/live` 차트가
 * 쓰지 않으므로 들지 않는다 — 들면 저장뷰 스키마가 바뀔 때마다 `/live` 스토어가
 * 흔들린다.
 */
import type { StudyViewListRow } from '../api/studyViews';
import { isMinuteTimeframe, type LiveTimeframe, type SavedRangeFocus } from '../state/livePage';
import { STUDY_VENUE } from './studyVenuePolicy';

/**
 * 저장뷰 기간이 걸린 `/live` 차트 창의 **venue**. 전역 선택기와 무관하게 KRX 다
 * (2026-08-21 사용자 결정).
 *
 * 근거는 ADR-0144 와 **같은 것**이라 상수도 같은 것을 참조한다 — 정책이 바뀌면 한
 * 곳만 고쳐야 한다. 요약하면: `SOURCE_VENUES`(hoga/api/sources.py) 에서
 * `hogaplay = frozenset({"KRX"})` 이고 디스크의 **78%가 hogaplay** 다. NXT·통합을
 * 요청하면 그 소스가 사다리에서 **후보째 빠져 빈 응답**이 온다(예전엔 더 나빴다 —
 * KRX 데이터를 NXT 라고 돌려줬고 실측 720건 중 494건이 그랬다). 게다가 분봉 세션
 * 창이 `09:00–15:30` → `08:00–20:00` 으로 넓어져(`liveVenueUsesExtendedMinuteWindow`)
 * x축과 봉 수가 저장 당시와 갈린다.
 *
 * ⚠ **고정 범위는 창 하나다.** 전역 `live.venue.v1` 도 다른 창도 건드리지 않는다 —
 * venue 선택은 탭 전역이라 여기서 전역을 밀면 저장뷰와 무관한 창·다른 브라우저 탭까지
 * 함께 바뀐다(ADR-0144 §3 이 정확히 반대한 구조). 대신 그 창의 헤더 표시가 전역
 * 선택과 어긋나므로 **칩에 「KRX 기준」을 병기**한다.
 */
export const SAVED_RANGE_VENUE = STUDY_VENUE;

export function savedRangeFocusFromView(row: StudyViewListRow): SavedRangeFocus {
  return {
    viewId: row.id,
    code: row.code,
    label: row.label,
    fromMs: row.range.from_ms,
    toMs: row.range.to_ms,
    fromDate: row.range.from_date,
    toDate: row.range.to_date,
    savedTimeframe: row.timeframe,
    savedBarSpan: row.viewport.bar_span,
  };
}

/**
 * 이 창이 기간 슬롯의 **대상인가** — freeze · venue 고정 · 기간 칩 셋이 이 하나를 쓴다.
 *
 * 세 표면이 한 술어를 공유하는 것이 계약이다. 갈라지면 「칩은 떠 있는데 얼지는 않은」
 * 같은 반쪽 상태가 생기고, 그건 화면만 봐서는 원인을 못 찾는다.
 *
 * `dailyOnly` 는 **분봉에 그 구간이 존재하지 않는** 출처가 세운다(봉 패턴 매치 —
 * 몇 년 전이라 분봉이 디스크에 없다). 저장뷰는 사용자가 직접 본 자리라 그 플래그가
 * 없고, 「일봉 밴드와 분봉 벽은 같은 슬롯의 두 표현」이라는 기존 계약 그대로 돈다.
 */
export function savedRangeAppliesTo(
  focus: SavedRangeFocus | null,
  code: string | null | undefined,
  timeframe: LiveTimeframe,
): boolean {
  if (focus === null || code !== focus.code) return false;
  return !(focus.dailyOnly && isMinuteTimeframe(timeframe));
}

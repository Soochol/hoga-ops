# 0060 — KIS 일별 walk-back 두 메서드는 통합 driver로 합치지 않는다 (공유 헬퍼만 추출)

**Status:** accepted (2026-06-03)

**Related:**
- ADR-0048 — Live Candle Backfill 일봉 (`fetch_past_daily_candles`)
- ADR-0055 — Live Investor Net (`fetch_investor_net`)
- `docs/superpowers/specs/2026-06-03-architecture-deepening-design.md` 후보 2

## Decision

`KisClient.fetch_past_daily_candles`(일봉)와 `fetch_investor_net`(투자자 순매수)는
둘 다 "60회 cap, `output2` 페이지를 읽고 커서를 (페이지 oldest − 1일)로 뒤로 감으며
`from`까지 paging"하는 **cursor walk-back** 모양을 갖는다. 한 아키텍처 리뷰가 이 둘을
하나의 `_walk_back_daily(parse_row)` driver로 통합하자고 제안했다.

**거부한다.** 대신 두 메서드가 *진짜로* 동일하게 쓰는 한 조각 — 커서 하루 감산
(`(YYYYMMDD − 1일)`) — 만 `_prev_day_yyyymmdd` 모듈 헬퍼로 추출하고, **두 walk-back
루프는 분리된 채로 둔다**.

## Why — skeleton이 "같지" 않다 (코드 검증)

핸들러 층(`/past-daily-candles` vs `/past-investor-net`)은 near-verbatim 쌍둥이라
공유 orchestrator로 통합했다(같은 후보 2의 핸들러 작업). 그러나 **KIS client 층의
walk-back skeleton은 legitimately 다르다**:

| 축 | 일봉 | 투자자 |
|---|---|---|
| 커서 param 슬롯 | `FID_INPUT_DATE_2`(walk), `DATE_1=from` 고정 | `FID_INPUT_DATE_1`(walk), DATE_2 없음, `from` 미전달 |
| 커서 앵커 | **valid 캔들의 earliest**만 | **모든 non-dup 날짜의 oldest**(out-of-range 포함) |
| 종료 분기 | `empty / no-progress`만 | + `page_oldest <= from → break` |
| out-of-range 행 | **violation 생성** | **조용히 skip** |
| per-row 검증 | close≤0 · OHLC 일관성 · 범위 · malformed (4종) | malformed만 |

통합 driver를 만들려면 최소한 `build_page_params(from, cursor)`(커서 슬롯) +
`parse_row(row)→{key, cursor_date, item, violation}`(앵커 의미·검증) 두 콜백에
더해, 종료/앵커 의미 차이를 흡수할 플래그가 필요하다. 그러면 driver의 **interface가
제거하는 중복만큼 복잡해진다** — Ousterhout/LANGUAGE.md의 deletion test 기준
*shallow abstraction*(복잡도가 한 곳에 집중되는 게 아니라 콜백으로 이동). 게다가
종료(`page_oldest <= from`)·앵커(earliest-valid vs oldest-any) 의미를 강제 통합하면
일봉 동작이 **drift**할 위험이 있다(현재 일봉엔 `<= from` 종료가 없다).

핸들러 층과 대비된다: 거기선 orchestration이 byte-identical이라 통합이 *복잡도를
집중*시켰다(real seam, two adapter). client 층은 varying 부분(파라미터·앵커·종료·검증)이
공유 부분(루프 cap·dedup·감산)보다 커서, 추출은 작은 헬퍼 하나로 멈추는 게 옳다.

## Consequences

- `_prev_day_yyyymmdd(yyyymmdd) -> str` 모듈 헬퍼 추가, 두 walk-back의 커서 감산이
  이를 호출. 한 줄짜리지만 fiddly한 날짜 산술을 명명·단일화(table-test).
- 두 walk-back 루프(parse + 종료 + 커서 앵커)는 **의도적으로 분리** 유지. 이는
  중복이 아니라 *서로 다른 KIS 계약*(DATE_1/DATE_2 의미, output2 스키마, 검증 taxonomy)을
  정직하게 반영한 것.
- 미래 아키텍처 리뷰/탐색이 "두 daily walk-back을 합쳐라"를 재제안하면 본 ADR이
  근거(검증된 skeleton 차이 + shallow-abstraction/behavior-drift 위험)를 제공해
  재litigate를 막는다.

## When to revisit

KIS가 두 endpoint의 파라미터·output 스키마·페이징 계약을 수렴시키거나, 세 번째
동형 daily walk-back endpoint가 추가돼 *세 개*가 같은 skeleton을 공유하게 되면(two→three
real adapter) 통합 driver의 depth가 재평가될 가치가 생긴다.

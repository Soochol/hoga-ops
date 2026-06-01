# 0055 — 당일 신고가/신고거래량을 별도 조건 타입으로 (lookback=1 프리셋 아님)

**Status:** accepted (2026-06-01)

**Related:**
- ADR-0004 (Wire model no-adapter, Pydantic ⇄ TS 손수 미러) — 타입 추가 비용(2언어 미러)의 출처.
- `docs/superpowers/specs/2026-06-01-screener-condition-taxonomy-design.md` — 이 ADR이 근거를 기록하는 스펙.
- `CONTEXT.md` **Breakout / Condition** 항목 — 당일/기간내 두 변형을 정의.

## Decision

"오늘이 N일 신고가"를 검사하는 **당일 신고가/신고거래량**을 **별도 조건 타입**
(`new_high_today`, `new_high_vol_today`, params `{period}` 1개)으로 신설한다. 기존
**기간내** 돌파(`new_high`/`new_high_vol`, params `{lookback, period}`)와 메뉴·폼에서 분리한다.

당일 타입은 SQL을 복제하지 않고 기존 `_breakout_cte`를 `lookback=1`로 호출해 컴파일한다
(VERBATIM 재작성 금지 준수). 즉 `new_high_today(period=P) ≡ new_high(lookback=1, period=P)`.

## Context

CONTEXT.md의 **Condition** 정의는 "사용자가 같은 타입을 중복 추가"하고 **Lookback Window N**을
자유 설정하도록 허용한다. 따라서 사용자는 **이미** `new_high {lookback:1, period:200}`를 직접
만들어 "당일 200일 신고가"를 표현할 수 있다 — 별도 타입 없이도. 그럼에도 별도 타입을 신설하는
것이 이 결정의 핵심이며, 맥락이 없으면 "왜 lookback=1짜리 타입을 따로?"라고 의아할 수 있다.

## Alternatives considered

### A. 별도 타입 신설 (채택)
폼이 숫자 **1개**(period)뿐 → 혼동↓. 메뉴에 "신고가"가 독립 노출 → 발견성↑. 트레이더 직관
("오늘 신고가" = bare 신고가, "기간내"는 한정어)과 일치. 사용자가 문자 그대로 요청한 형태.

### B. lookback=1 프리셋/토글 (기각)
백엔드 무변경·마이그레이션 0. 그러나 폼에 lookback 칸이 그대로 보이거나 "당일/기간내" 토글이라는
또 다른 UI 개념을 만들어야 하고, 메뉴 독립 항목이 안 생긴다 — 단순화라는 본질 가치를 못 살린다.

## Consequences

**Positive:** 당일 조건이 한 줄(`_breakout_cte` lookback=1 호출)로 끝나 신규 SQL·검증 표면 0.
거래대금은 **임계값 가족**(당일 `trade_value` + 기간내 `trade_value_period`), 신고가/신고거래량은
**돌파 가족**(당일 + 기간내)으로 축이 대칭·명료.

**Negative / watch:** 2언어 미러에 type 키 3개 추가(byte 불일치 시 422 — catalog.test 키 단언이 가드).
저장된 `new_high_today` leaf가 생기면 나중에 프리셋으로 합치려 할 때 saves.json 마이그레이션이 필요
(되돌리기 비용). 메뉴에 "신고가"와 "기간내 신고가"가 공존 — 페어링 순서(`CONDITION_ORDER`)로 완화.

## Scope boundary

당일 변형은 **돌파 가족**(신고가·신고거래량)에만 적용한다. **거래대금에는 당일 변형을 만들지 않는다**
— 거래대금은 이미 당일 임계값(`trade_value`)이 있고, 추가분은 기간내(`trade_value_period`)뿐이다.

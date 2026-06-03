# ADR-0063: hogaplay open_ms=0 분류단계 정상화

## Status
Accepted (2026-06-03)

## Context
hogaplay가 특정 거래일 전체에 대해 info.tsv의 `regular_session_open_ms`를 0으로
내려보낸다(close는 정상). raw 값 자체가 0이며 파서는 정확히 읽는다 — 순수 업스트림
결함이다. open=0은 `meta.open_in_kst_range`(error)를 발화시켜 source를 INVALID로
만들고, read-path(`build_range_bundle`)가 그 날짜를 `excluded_dates`로 빼 차트·조회에서
사라진다. 그러나 거래·호가 데이터와 수집·밀도는 정상인 경우가 대부분이다.

전체 parquet 스캔(2322 meta) 결과: `open_ms=0`은 32건(2026-03-18, 2026-06-02),
그중 31건이 salvageable(시각만 결함, `collection_complete=True`·`is_partial=False`).
별개로 `close_ms=0`은 129건(6개 날짜)이나 `collection_complete=False`/`is_partial=True`
복합 결함으로 메타 보정만으론 못 살리는 별도 트랙이다.

## Decision
검사 규칙 단일 출처인 `hoga/api/invariants.py::check()` 진입부에서
`regular_session_open_ms == 0`을 KRX 표준 09:00(`90_000_000`)으로 정상화한 사본으로
invariant를 평가하고, `meta.open_ms_normalized`(warn) 꼬리표를 추가한다. 원본
meta.json은 불변(메모리 내 사본만 정상화).

read-path 값 변환처(`bundle.py`, `queries.py`)는 `check()`를 거치지 않고 meta에서
open을 직접 unix로 변환하므로, 같은 `normalize_session_bounds` 헬퍼를 변환 직전에
명시 적용한다. 단 분류(`classify_from_meta`)는 원본 meta로 수행해 warn 꼬리표가 한 번만
생성되게 한다(분류는 꼬리표 전담, 변환은 값만 — 책임 분리). `close_ms`는 손대지 않는다.

09:00은 KRX 정규장 정의상 시가이자 추측이 아닌 상수다. 정상화는 `open == 0`이라는
명백한 sentinel에만 적용하고, 0이 아닌 범위 밖 값(예: 다른 인코딩 오류)은 여전히
INVALID로 정확히 탐지한다 — invariant의 탐지력을 잃지 않는다.

## Consequences
- salvageable 31건 + 미래 발생분이 재파싱 없이 COMPLETE로 분류된다(검증:
  002380/2026-06-02 및 003490·003670·009830/2026-03-18 → COMPLETE + open_ms_normalized warn;
  002380/2026-03-18은 `collection_complete=False`라 CLIENT_INCOMPLETE 유지 — 정상).
- `check()`가 공유 술어이므로 정상화가 분류를 거치는 모든 소비자에 일관 적용된다:
  aggregate `check_disk_state`가 COMPLETE → eligibility가 `already_complete`로 skip(불필요
  재캡처 방지), fail_streak 리셋, watchlist 마커 전진, calendar cell `complete`. 모두
  의도된 올바른 결과이며, check() 레벨에서 고치는 이유가 이 일관성이다.
- 꼬리표는 차트 read-path(`DateWarning` → `data_warnings`)와 `hoga validate`에 노출된다.
  inventory `StockDate` row는 warn 목록 필드가 없어 꼬리표 미노출이나, `disk_state`
  문자열은 `invalid`→`complete`로 정상 전환되어 활용 목표는 달성된다.
- `close_ms=0` 129건은 미해결 — 수집 미완 복합 결함으로 별도 재캡처 트랙(후속 ADR).

## References
- 스펙: `docs/superpowers/specs/2026-06-03-open-ms-zero-normalize-design.md`
- 관련: ADR-0020(invariant catalog), ADR-0021(no-upstream-data sentinel),
  ADR-0037/0039(source aggregation), ADR-0042(fail-streak), ADR-0034(watchlist marker).

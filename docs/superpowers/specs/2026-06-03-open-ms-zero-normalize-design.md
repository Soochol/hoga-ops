# hogaplay `open_ms=0` 분류단계 정상화 — Design

**Date**: 2026-06-03
**Status**: Approved
**Scope**: hoga/api/invariants.py, hoga/api/bundle.py, hoga/api/queries.py, hoga/api/disk_state.py (간접), tests/api/test_invariants*.py, docs/adr/0063-*.md

## Problem

hogaplay 업스트림이 **특정 거래일 전체**에 대해 `info.tsv`의 정규장 시가 시각
필드(`regular_session_open_ms`)를 `0`으로 내려보내는 결함이 있다. 그날 캡처한 거의
모든 종목이 동시에 영향받는다(예: 2026-03-18 20/20, 2026-06-02 12/25). raw 값
자체가 `…KCC\t0\t0\t153000000…`로, 파서는 정확히 읽었고 `close`(153000000=15:30)는
정상이다 — **순수 업스트림 결함**이다.

`open_ms=0`은 `meta.open_in_kst_range`(error) invariant를 건드려 해당 source를
`DiskState.INVALID`로 만든다. 그 결과 read-path(`build_range_bundle`)가 그 날짜를
`excluded_dates`로 빼버려 **차트·조회에서 보이지 않는다**. 그런데 거래·호가
데이터 자체는 멀쩡하게 수집됐다(`collection_complete=True`, `is_partial=False`,
첫 09:12~막 15:30, 최대 갭 48.6초).

사용자: *"hogaplay 자체에 문제가 있는 건 맞아. 그런데 데이터를 우리 프로젝트에서
활용하고 싶어서 그래."*

**영향 범위(스캔 결과, 전체 2322 meta)**: `open_ms=0`은 32건(2개 날짜), 그중
**31건이 salvageable**(시가 시각만 결함, 수집·밀도는 완전). 별개로 `close_ms=0`은
129건(6개 날짜)이 존재하나, 이들은 `collection_complete=False`/`is_partial=True`인
복합 결함이라 본 spec의 대상이 아니다(Non-Goals 참조).

## Invariants

- **단일 분류기 권위**: `check_disk_state`/`classify_from_meta`가 (종목,거래일)
  OK 판정의 유일한 권위이며, `DiskState.COMPLETE`만이 "완전/OK"다.
  근거: [disk_state.py](../../../hoga/api/disk_state.py), [ADR-0020](../../adr/0020-data-integrity-invariant-catalog.md).
- **INVALID > 완전성 우선순위**: error-severity invariant 위반은 `collection_complete`
  검사보다 **먼저** 평가되어, shape 깨짐이 불완전성을 trump한다.
  근거: disk_state.py:118-124, ADR-0020.
- **원본 capture 데이터 불변**: 분류·검사·read-path는 meta.json과 parquet을
  **읽기만** 한다. 쓰지 않는다(`hoga validate --fix`조차 archival
  `invariant_violations` 필드만 재기록). 근거: cli.py:229-325, ADR-0020.
- **세션 경계 KST 인코딩**: `open∈[04:00,12:00]`, `close∈[12:00,18:00]`,
  `close>open` (HHMMSSmmm 인코딩). 근거: invariants.py:81-124.
- **warn은 state 불변**: warn-severity violation은 `Classification.warnings`로
  노출되지만 `DiskState`를 강등하지 않는다(오직 `Severity.error`만 게이트).
  근거: disk_state.py:119.
- **검사 규칙 단일 출처**: 4개 체크포인트(parser write-time, disk_state classify,
  bundle read-path, cli validate)가 모두 `invariants.check()` 한 곳을 통과한다.
  근거: invariants.py:1-9 모듈 docstring, `check()` line 200.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 단일 분류기 권위 | preserves | 정상화는 `check()` 한 곳에만 들어간다; 분기 추가 없음 |
| INVALID > 완전성 우선순위 | preserves | 정상화 후에도 우선순위 동일. `open=0` 외 다른 이상값은 여전히 INVALID |
| 원본 capture 데이터 불변 | preserves | 메모리 내 **사본**의 open만 09:00으로 치환; meta.json/parquet 미수정 |
| 세션 경계 KST 인코딩 | **intentionally breaks (`open==0` 한정)** | `0`을 "범위 밖 error"가 아니라 "미기록 → 09:00 복원"으로 재해석 |
| warn은 state 불변 | preserves | 보정 꼬리표를 warn(`meta.open_ms_normalized`)으로 추가 → COMPLETE 유지 |
| 검사 규칙 단일 출처 | preserves | 분류 정상화는 `check()` 한 곳; read-path **값 변환**은 `check()` 밖 2곳(bundle/queries)이라 같은 `normalize_session_bounds` 헬퍼를 명시 적용(grep 전수 확인) |

**"intentionally breaks" 정당화** — 세션 경계 KST 인코딩 invariant는 "시가는
04:00–12:00 안의 실제 시각"을 기대한다. `open_ms==0`은 그 범위 밖이라 error로
잡히지만, 이는 *잘못된 시각*이 아니라 *시각 미기록*이다. KRX 정규장은 정의상 항상
09:00에 시작하고(연속매매 기준), kis_live source도 같은 값(`90000000`)을 하드코딩한다.
따라서 `0 → 09:00` 복원은 추측이 아니라 **상수 복원**이며, 거래·호가 데이터는 일절
바뀌지 않는다. 정상화는 `open==0`이라는 명백한 sentinel에만 적용하고, `0이 아닌`
범위 밖 값(예: 미래의 다른 인코딩 오류)은 그대로 INVALID로 둔다 — invariant의
탐지력을 잃지 않는다. 보정 사실은 warn 꼬리표로 영구 추적된다.

## Goals

- `open_ms=0` salvageable 31건(2026-03-18 19건 + 2026-06-02 12건, 002380 포함)이
  `check_disk_state` → `DiskState.COMPLETE`로 분류되어 read-path에 노출된다.
- 미래에 같은 `open=0`이 들어와도 **재파싱 없이 자동** 정상화된다.
- 원본 meta.json·parquet은 **바이트 단위로 불변**.
- 보정된 (종목,거래일)은 `meta.open_ms_normalized`(warn)로 추적 가능하다 — 차트
  read-path(`DateWarning`)와 `hoga validate`에 노출. (단 inventory `StockDate` row는
  warn 목록 필드가 없어 꼬리표 미노출 — `disk_state` 문자열은 `complete`로 정상 전환.
  Risks 참조.)
- `check()`가 공유 술어이므로 정상화는 **분류를 거치는 모든 소비자에 일관 적용**된다:
  aggregate `check_disk_state`가 COMPLETE → eligibility가 `already_complete`로 skip(불필요
  재캡처 방지), fail_streak 리셋, watchlist 마커 전진, calendar cell이 `complete`. 모두
  **의도된 올바른 결과**이며, check() 레벨에서 고치는 이유가 바로 이 일관성이다.
- `close_ms=0` 129건과 정상 시각 데이터는 **영향받지 않는다**(회귀 테스트로 고정).

## Non-Goals

- **`close_ms=0` 129건(2026-03-13/03-31/05-18/05-26/05-27/06-01)**: 이들은
  `collection_complete=False`/`is_partial=True`인 복합 결함이다. `close=0`이
  `has_meaningful_gaps`의 분석 window(`auction_start = close − 10min`)를 음수로
  오염시켜 `is_partial`을 강제 True로 만들고, 수집 자체도 미완이다. 09:00 류의
  단순 치환으로 살릴 수 없고 **재캡처가 필요한 별도 트랙**이다. 후속 spec에서 다룬다.
- `open_ms`의 `0`이 아닌 이상값 정상화(범위 밖 오타 등) — 그대로 INVALID 유지.
- 첫 거래/스냅샷 시각 기반 보정 — "장 시작"이 세션 경계의 정의이므로 09:00 상수 사용.
- 프론트엔드 UI에서 warn 꼬리표를 시각적으로 어떻게 렌더할지 — 별도 작업.
- `meta.json`을 영구 재기록하는 마이그레이션 — 본 spec은 read-time 정상화만.

## Design

### 정상화 지점: `invariants.check()`

검사 규칙 단일 출처인 `hoga/api/invariants.py::check()`(line 200)가 모든
체크포인트의 공통 진입부다. 여기에 invariant 평가 **직전** 세션 경계 정상화를
삽입하면 4개 체크포인트가 자동으로 일관된다.

```python
# 인코딩 상수 (invariants.py 상단, 기존 주석과 정합)
_KRX_REGULAR_OPEN_MS = 90_000_000  # 09:00:00.000, KRX 정규장 정의상 시가

def _normalize_session_bounds(meta: dict) -> tuple[dict, list[Violation]]:
    """알려진 업스트림 sentinel(open_ms==0)을 KRX 표준 09:00으로 복원한 사본과,
    보정이 일어났을 때의 warn violation을 반환한다. 원본 meta는 변경하지 않는다.
    close_ms는 의도적으로 건드리지 않는다(Non-Goals: 별도 복합 결함)."""
    if meta.get("regular_session_open_ms") != 0:
        return meta, []
    patched = {**meta, "regular_session_open_ms": _KRX_REGULAR_OPEN_MS}
    note = Violation(
        "meta.open_ms_normalized",
        Severity.warn,
        "upstream sent regular_session_open_ms=0; normalized to KRX 09:00 for classification",
        {"original_open_ms": 0, "normalized_open_ms": _KRX_REGULAR_OPEN_MS},
    )
    return patched, [note]

def check(meta: dict) -> list[Violation]:
    patched, notes = _normalize_session_bounds(meta)
    return notes + [v for inv in INVARIANTS if (v := inv.check(patched)) is not None]
```

### 동작 결과

- `open_ms==0` & 그 외 정상: `_meta_open_in_kst_range`가 정상화된 09:00으로
  평가 → 위반 없음. `meta.open_ms_normalized`(warn) 1개만 남음.
  `classify_from_meta`: error 없음 → `collection_complete` True → `is_partial`
  False → **COMPLETE**. warn은 state를 강등하지 않으므로(불변 보존) COMPLETE 유지.
- `open_ms==0` & 동시에 다른 error(예: 그날 수집 미완으로 별도 위반): 정상화는
  open만 살리고, 나머지 error는 그대로 평가되어 INVALID/CLIENT_INCOMPLETE 유지.
  (스캔상 31/32가 open만 결함이라 대부분 COMPLETE로 살아난다. 002380/2026-03-18
  한 건은 `collection_complete=False`라 정상화 후에도 CLIENT_INCOMPLETE — 정상.)
- `close_ms==0`: `_normalize_session_bounds`가 손대지 않음 → `meta.close_after_open`
  + `meta.close_in_kst_range` error 그대로 → INVALID 유지(별도 트랙 보존).
- 정상 시각 meta: `open_ms != 0` 분기에서 즉시 원본 반환 → 동작·결과 완전 불변.

### read-path 값 변환처 정상화 (분류만으로 부족)

`check()` 정상화는 **분류 게이트**만 푼다. 그러나 `bundle.py:422`와
`queries.py:194`는 분류를 통과한 뒤 **원본 meta dict에서 `regular_session_open_ms`를
직접** 읽어 `hhmmssms_to_unix_ms(...)`로 변환해 응답(`RangeSegment.session_open_ms`,
`StockDate.regular_session_open_ms`)에 넣는다. 이 두 곳은 `check()`를 거치지 않으므로,
분류만 고치면 COMPLETE로 살아나도 **응답에는 여전히 0이 흘러간다**. grep 전수 확인
결과 `open`을 *값으로 변환·소비*하는 곳은 정확히 이 둘뿐이다(`promote.py`는 생성=
90000000, `parser.py`는 raw 파싱/원본 archival, `models.py`는 타입 선언).

따라서 `_normalize_session_bounds`를 **public `normalize_session_bounds`** 로 노출하고,
두 변환처가 open을 변환하기 직전 정상화된 값을 쓰게 한다. 단 **분류는 원본 meta로**
수행해 `check()` 내부 정상화가 warn 꼬리표를 생성하게 한다 — 값 변환만 정상화하고
꼬리표는 분류가 전담(책임 분리, 꼬리표 중복 방지):

```python
# bundle.py / queries.py 공통 패턴
meta = <load>                              # 원본 (open=0 가능)
c = classify_from_meta(meta)               # 원본으로 분류 → check()가 정상화 평가 + warn 생성
norm, _ = normalize_session_bounds(meta)   # 값 변환용 정상화 (notes는 분류가 이미 처리)
session_open_ms = hhmmssms_to_unix_ms(d, norm["regular_session_open_ms"])
```

이로써 분류(check)와 응답 변환(bundle/queries)이 동일한 09:00을 보고, 꼬리표는
한 번만(분류에서) 생성된다. `close_ms`는 두 변환처에서도 손대지 않는다. 정상 시각
meta는 `normalize_session_bounds`가 원본을 그대로 반환하므로 동작 불변이다.

### archival 경로

parser write-time(`parser/__init__.py`의 `check()` 호출)도 같은 `check()`를
통하므로, 미래 캡처가 `open=0`을 받으면 meta.json의 `invariant_violations`
archival에 `meta.open_ms_normalized`(warn)가 기록된다. open_ms 원본 값은 여전히
`0`으로 보존된다(원본 불변). 분류 시 read-time 정상화가 다시 COMPLETE를 만든다.

### `check_series`/series invariant

본 spec은 meta invariant만 건드린다. `check_series`(line 351)는 변경 없음.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| open=0 정상화 → COMPLETE | meta {open=0, close=153000000, cc=True, is_partial=False} | `classify_from_meta` == COMPLETE; warnings에 `meta.open_ms_normalized` |
| 정상 open 불변 | meta {open=90000000, …} | warning 없음; 결과 변화 없음 (정상화 미발생) |
| open=0 + 수집 미완 | meta {open=0, cc=False} | CLIENT_INCOMPLETE (open은 살아도 완전성에서 막힘) |
| close=0 여전히 INVALID | meta {open=90000000, close=0} | INVALID; `meta.close_after_open`+`meta.close_in_kst_range` 유지; 정상화 미발생 |
| 범위 밖 비-0 open 유지 | meta {open=130000000} | INVALID `meta.open_in_kst_range` (sentinel 아님 → 정상화 안 함) |
| archival 기록 | parser write-time `check()` on open=0 | `invariant_violations`에 `meta.open_ms_normalized` warn; 원본 open_ms=0 보존 |
| 002380/2026-06-02 회귀 | 실 디스크 (종목,거래일) | per-source hogaplay == COMPLETE; aggregate `check_disk_state` == COMPLETE |
| read-path 변환 정상화 | bundle/queries: open=0 meta | 응답 `session_open_ms`/`regular_session_open_ms` == 09:00 unix(d), **0 아님** |
| 변환 꼬리표 비중복 | bundle: open=0 meta | `data_warnings`에 `meta.open_ms_normalized` 정확히 1개 (변환처가 추가 생성 안 함) |

**기존 테스트 reconcile (필수)**: `check()`는 4개 체크포인트가 공유하는 술어라
`open=0`이 error→warn, INVALID→COMPLETE로 바뀐다. 기존 테스트 중 `open=0`을
`meta.open_in_kst_range` error나 INVALID로 단정하는 케이스는 새 동작으로 갱신해야
한다. 구현 **전** `tests/`에서 `open_in_kst_range`/`open_ms`=0 fixture/`INVALID` 단정을
grep해 목록화하고, plan에서 각 reconcile을 task로 잡는다(1순위 후보:
`tests/hoga/api/test_invariants.py`, `tests/test_api_disk_state.py`,
`tests/unit/api/test_disk_state_source.py`). 첫 `pytest`가 이 변경으로 red인 것은
회귀가 아니라 기대된 reconcile임을 plan에 명시한다.

**Invariant 회귀 테스트**: "preserves" 항목 각각 —
- 원본 불변: 정상화 호출 전후 입력 `meta` dict 동일성(`==` 및 `open_ms` 키 0 유지).
- warn은 state 불변: open=0 + cc=True + is_partial=False → COMPLETE이면서 warning 보유.
- INVALID>완전성: open=0 + (가짜 series error) → 여전히 INVALID.
- close=0 별도 트랙: close=0 meta 129 프로필이 정상화 후에도 INVALID.

### Manual verification

- `hoga validate --code 002380`(또는 sweep)에서 2026-06-02가 더 이상 error로
  뜨지 않고 `meta.open_ms_normalized` warn으로 표시되는지.
- 차트/조회 read-path(`/replay` 또는 inventory calendar)에서 002380/2026-06-02 및
  2026-03-18 종목들이 `excluded_dates`에서 빠지고 표시되는지.
- inventory calendar에서 2026-06-02 / 2026-03-18 셀이 `invalid` → `complete`로 바뀌는지.
- `decide_capture`(eligibility)가 이 (종목,거래일)을 `already_complete`로 skip하는지
  (불필요 재캡처 안 함), `check_disk_state` aggregate가 COMPLETE인지.

## Risks / Open questions

- **bundle/queries의 open_ms 직접 사용 — 확인 완료(해소)**: grep 전수 결과
  `bundle.py:422`·`queries.py:194` 두 곳이 분류 통과 후 `regular_session_open_ms`를
  직접 변환해 응답에 넣는다. 본 spec의 "read-path 값 변환처 정상화"가 이를 다룬다.
  그 외 open을 *값으로* 쓰는 경로는 없다(promote=생성, parser=원본 기록, models=타입).
  미래에 새 변환처가 생기면 같은 헬퍼를 적용해야 하므로, `normalize_session_bounds`
  docstring에 "open을 값으로 소비하기 전 호출" 규약을 명시한다.
- **warn 꼬리표의 read-path 노출량**: 31건이 `data_warnings`로 노출되면 calendar/
  bundle 응답에 warn이 늘어난다. 기존 warn 처리(노출만, state 불변)와 동일 경로라
  기능 위험은 없으나, 프론트 표기는 별도 작업(Non-Goals).
- **inventory row는 warn 꼬리표를 못 싣는다**: `StockDate`(models.py:24-63)에 warn/
  violation 목록 필드가 없다. 보정 꼬리표는 차트(`DateWarning`)·CLI(`validate`)에만
  보이고 inventory 리스트엔 안 뜬다. 단 `disk_state` 문자열이 `invalid`→`complete`로
  정상 전환되어 활용 목표는 달성된다. inventory에도 꼬리표를 띄우려면 `StockDate`에
  필드 추가가 필요 — Backlog.

## Out of Scope (Backlog)

- **`close_ms=0` 129건 재캡처 트랙**: 수집 미완 복합 결함. 재캡처 또는
  close 정상화+재평가가 가능한지 별도 spec.
- **ADR 번호 충돌 정리**: 0057·0059·0062가 각각 두 ADR에 중복 부여됨(별도 정리 필요).
  본 변경은 다음 가용 번호 **ADR-0063**을 사용한다.
- **영구 meta 마이그레이션**: read-time 정상화로 충분하지만, 장기적으로 백필 시
  meta.json의 open을 09:00으로 재기록할지 여부.

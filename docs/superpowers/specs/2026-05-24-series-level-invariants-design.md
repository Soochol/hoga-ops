# Series-Level Invariants — Catalog Split + Existing Validator Integration

**Status:** implemented (2026-05-24)

## 1. Goal

ADR-0020 landed a meta-level invariant catalog (5 rules over `meta.json` dict). It covered the 5/18/003490 root cause (`close_ms=0`) but cannot reach failures that only appear in the *series* — candle timestamps regressing, snapshot streams with multi-minute gaps inside session, trade cumulative-volume regressions. Two existing validators already cover parts of this ground: [`disk_state.has_meaningful_gaps`](../../../hoga/api/disk_state.py) and [`tables/trades.validate`](../../../hoga/tables/trades.py). They live outside the invariants seam, so neither flows into `excluded_dates` / `data_warnings` on the wire, neither shows up in `hoga validate`, and neither has a unified surfacing channel.

This spec **adds a second invariant catalog** (`SERIES_INVARIANTS`) for Stock-Date-level series checks, **absorbs the two existing validators** into it without removing them, and **extends `hoga validate` with a `--deep` flag** that loads parquet artifacts and runs series invariants. The meta catalog (now renamed `META_INVARIANTS`) stays unchanged — meta-only callers pay zero extra cost.

## 2. Non-goals

| 항목 | 이유 |
|---|---|
| `build_range_bundle`가 매 요청마다 series invariants 실행 | parquet I/O 비용 너무 큼. 대신 parser write-time archival에 결과 저장, read-path는 archival 우선 신뢰 (§7 ADR-0020 예외 명시). |
| `trades.validate` 제거 | parser write-path가 strict mode로 의존 (깨진 parquet 생성 차단). 함수 보존, 내부 로직만 재사용. |
| `has_meaningful_gaps` 제거 | parser의 `is_partial` 계산이 의존. 함수 보존, invariant가 호출만. |
| 시계열 invariant의 자동 데이터 수정 | ADR-0020 동일 원칙 — 재캡처가 유일한 복구. |
| 다른 도메인의 시계열 검사 (orderbook spread sanity 등) | 다음 PR. 본 spec은 candles/snapshots/trades 세 표만. |

## 3. 합의된 결정

| 항목 | 결정 |
|---|---|
| 카탈로그 분할 | `META_INVARIANTS` (기존, 이름만 변경) + `SERIES_INVARIANTS` (신규) |
| Series invariant 시그니처 | `Callable[[StockDateArtifacts], list[Violation]]` (한 invariant가 0~N 위반 반환 가능) |
| `StockDateArtifacts` | `(meta, candles?, snapshots?, trades?)` 데이터클래스 — Optional 필드라 부분 로드 가능 |
| 새 진입점 | `check_series(artifacts) -> list[Violation]` ; 기존 `check(meta)`는 변경 없음 |
| 카탈로그 등록 invariants | `series.candles_ts_monotonic` (error), `series.snapshots_no_gaps` (warn), `series.cum_vol_monotonic` (~~error~~ → **warn**, 정정: ADR-0020 amendment 2026-06-08 — cum_vol 은 형태 불변이 아닌 신뢰 신호) |
| 기존 validator 통합 | `has_meaningful_gaps`/`trades.validate` 함수는 유지, 내부 로직을 추출해서 invariant가 재사용 |
| `trades.find_cum_vol_violations` 신규 헬퍼 | pure function, `validate(strict)`도 이를 호출하여 raise |
| `hoga validate --deep` | 기본은 meta-only (빠름), `--deep`이면 series 카탈로그 적용 + parquet 로드 |
| `build_range_bundle` 변경 | 없음 — series invariants 결과는 parser write-time archival에서 읽음 (ADR-0020 self-healing 원칙의 명시적 예외) |
| Archival 위치 | `meta.json`의 `invariant_violations` 필드에 series 결과도 함께 박음 (분리 X) |
| ADR | ADR-0020을 갱신: §3a-b 다음에 §3c "series-level은 archival-cached" 추가 |

## 4. 아키텍처

### 4.1 모듈 경계

```
hoga/api/invariants.py        ← StockDateArtifacts 타입 + SERIES_INVARIANTS 카탈로그 + check_series()
                                기존 INVARIANTS → META_INVARIANTS로 rename
hoga/tables/trades.py          ← find_cum_vol_violations() pure helper 추출; validate()는 helper + raise
hoga/parser/__init__.py        ← write-path에서 series invariants 평가 + archival에 통합
hoga/cli.py                    ← validate 명령에 --deep 플래그 추가; series invariant 실행 + 보고
docs/adr/0020-...md            ← series-level archival-cached 예외 §3c 추가
```

### 4.2 핵심 타입

```python
# hoga/api/invariants.py 확장

from hoga.tables.candles import Candle
from hoga.tables.snapshots import Orderbook
from hoga.tables.trades import Trade


@dataclass(frozen=True)
class StockDateArtifacts:
    """Series-level invariant input. Callers load disk once and pass.

    Fields are Optional so partial loading works:
      - hoga validate --deep loads all four
      - parser archival passes all four (already in memory at meta write time)
      - future per-table checks can pass just one
    """
    meta: Mapping[str, Any]
    candles: list[Candle] | None = None
    snapshots: list[Orderbook] | None = None
    trades: list[Trade] | None = None


@dataclass(frozen=True)
class SeriesInvariant:
    """Series invariant returns a list (not a single Violation) so one
    invariant can flag multiple violations across the series (e.g.,
    every cum_vol regression in trades.parquet)."""
    id: str
    severity: Severity
    description: str
    check: Callable[[StockDateArtifacts], list[Violation]]


SERIES_INVARIANTS: tuple[SeriesInvariant, ...] = (...)  # §5

def check_series(artifacts: StockDateArtifacts) -> list[Violation]:
    """Run every series invariant. Returns flat violation list across all."""
    out = []
    for inv in SERIES_INVARIANTS:
        out.extend(inv.check(artifacts))
    return out
```

### 4.3 META_INVARIANTS rename

```python
# Before:  INVARIANTS: tuple[Invariant, ...] = (...)
# After:   META_INVARIANTS: tuple[Invariant, ...] = (...)
#          INVARIANTS = META_INVARIANTS  # backward-compat alias
```

`check(meta)`는 변경 없음. 외부 import (`from hoga.api.invariants import INVARIANTS`)는 alias로 통과. 새 코드는 명시적 이름 사용.

### 4.4 `trades.validate` 리팩터

```python
# hoga/tables/trades.py

@dataclass(frozen=True)
class CumVolViolation:
    index: int       # position in sorted continuous-trade list
    prev_cum: int
    curr_cum: int
    ts_ms: int       # current row ts_ms for context

def find_cum_vol_violations(trades: list[Trade]) -> list[CumVolViolation]:
    """Pure: returns every cum_vol regression in continuous-trade rows
    (side != 0), sorted by (ts_ms, seq). Auction Cross rows excluded.
    The strict ``validate`` wraps this and raises on the first item."""
    ...

def validate(trades: list[Trade], *, lenient: bool = False) -> None:
    violations = find_cum_vol_violations(trades)
    if violations and not lenient:
        raise TradeValidationError(...)
```

Series invariant `series.cum_vol_monotonic`은 `find_cum_vol_violations`를 호출하여 결과를 `Violation` 리스트로 매핑.

### 4.5 Parser archival hook 확장

```python
# parser/__init__.py — meta.json 쓰기 직전 (현 archival hook 자리)

from hoga.api.invariants import StockDateArtifacts, check, check_series
all_violations = check(meta) + check_series(
    StockDateArtifacts(
        meta=meta,
        candles=candles_list,
        snapshots=snapshots_list,
        trades=trades_list,
    )
)
if all_violations:
    meta["invariant_violations"] = [v.as_dict() for v in all_violations]
```

`check`와 `check_series` 둘 다 호출. 결과는 같은 `invariant_violations` 필드에 통합. severity별 partition은 read-path가 처리.

### 4.6 read-path는 archival 우선

ADR-0020 본문은 "read-paths re-evaluate live"로 self-healing 원칙. 본 spec은 series-level에 한해 그 예외:

- `classify_from_meta(meta)`는 여전히 meta-level invariants live 평가
- series-level은 평가 비용 (parquet 로드 + iteration)이 read-path SLO와 양립 X
- 대신 parser archival의 `invariant_violations` 필드를 우선 신뢰
- 카탈로그 업데이트 후 stale 가능성은 `hoga validate --deep --fix`로 일괄 재기록 (사용자 명시 행동)

ADR-0020 §3c로 명시: "series-level invariants는 archival-cached이며 read-paths는 live 평가하지 않는다. catalog 업데이트 시 `hoga validate --deep --fix`로 일괄 갱신."

### 4.7 `hoga validate --deep`

```bash
hoga validate              # meta-only sweep (현재 동작)
hoga validate --deep       # meta + series sweep (parquet 로드)
hoga validate --deep --fix # series 평가 결과까지 archival 박음
hoga validate --code 003490 --deep   # 한 종목 깊은 검사
```

`--deep` 없는 sweep은 parquet 로드 안 함 (성능 회귀 없음).

## 5. 시계열 invariant 카탈로그 (3개)

### error — 데이터 형태 자체가 깨짐

| ID | 검사 |
|---|---|
| `series.candles_ts_monotonic` | sorted by `ts_ms` 한 candles에서 `candles[i].ts_ms < candles[i+1].ts_ms`. 같거나 역행 시 fire. **이게 5/18 chart 충돌의 직접 원인이었음**. |
| `series.cum_vol_monotonic` | `trades.find_cum_vol_violations(trades)`가 반환한 모든 항목을 violation으로 변환. 각 violation의 ctx에 `{index, prev_cum, curr_cum, ts_ms}` 포함. |

### warn — 신뢰도 낮음

| ID | 검사 |
|---|---|
| `series.snapshots_no_gaps` | `has_meaningful_gaps(snapshots ts_ms HogaMs)` True면 fire. ctx에 `{datapoint_count}` 포함. 이미 `is_partial` boolean에서 표현되는 정보지만 wire에 별도 노출. |

## 6. 테스트 전략

| 계층 | 위치 | 케이스 |
|---|---|---|
| 단위 (series) | `tests/hoga/api/test_series_invariants.py` (신규) | 3 invariant × {정상, 위반} = 6 케이스. 인메모리 fixture, parquet I/O 없음. |
| 단위 (trades helper) | `tests/hoga/tables/test_trades.py`에 추가 | `find_cum_vol_violations`의 단일/다중/0건/auction cross 제외 케이스 |
| 통합 (parser archival) | `tests/test_parser_completeness.py`에 추가 | 깨진 candles fixture → meta.json의 `invariant_violations`에 `series.candles_ts_monotonic` 박혀 있음 |
| 통합 (DiskState live) | 변경 없음 | classify_from_meta는 meta-only — series 무관 |
| E2E (CLI) | `tests/test_cli_validate.py`에 추가 | `--deep` 플래그 동작, `--deep --fix` 멱등성 |
| Regression | 5/18 003490 candles.parquet 실데이터를 fixture로 박음 | 미래 카탈로그 변경 시 이 case가 깨지면 CI fail |

## 7. 호환성

- 외부 `from hoga.api.invariants import INVARIANTS`: alias로 호환
- `trades.validate`: 시그니처/동작 동일 (내부만 `find_cum_vol_violations` 사용)
- `has_meaningful_gaps`: 시그니처/동작 동일
- Parser write-path: archival에 series 위반도 박힘 → meta.json `invariant_violations` 필드 길이 증가 가능. JSON consumer 무관.
- `hoga validate`: 기본 동작 무변경, `--deep` 추가만

## 8. 작업 순서 (구현 plan의 시드)

1. `trades.find_cum_vol_violations` 추출 + `validate` 리팩터 + 테스트
2. `hoga/api/invariants.py`: `StockDateArtifacts`, `SeriesInvariant`, `META_INVARIANTS` rename + alias, `SERIES_INVARIANTS` 빈 튜플 + `check_series` 함수
3. `series.candles_ts_monotonic` 등록 + 단위 테스트
4. `series.snapshots_no_gaps` 등록 + 단위 테스트 (`has_meaningful_gaps` 호출)
5. `series.cum_vol_monotonic` 등록 + 단위 테스트 (`find_cum_vol_violations` 호출)
6. `parser/__init__.py` archival hook이 `check + check_series` 둘 다 호출
7. `cli.py validate` 명령에 `--deep` 플래그 추가 + 테스트
8. ADR-0020 §3c 추가 (series-level archival-cached 예외)
9. CONTEXT.md에 `StockDateArtifacts` 용어 등록 (필요시)
10. 5/18 003490 실데이터로 end-to-end 검증

## 9. 미해결 / Follow-up

| 항목 | 다음 단계 |
|---|---|
| `build_range_bundle`이 archival을 우선 신뢰 | 별 PR. 현재는 archival을 wire에 노출만, bundle 동작은 변경 X |
| Series invariants를 frontend banner에 표시 | 자동 노출됨 (이미 ExcludedDate.violations / DateWarning.warnings로 흐름). 추가 작업 없음 |
| Orderbook spread sanity, snapshot quote totals 일관성 등 더 많은 시계열 invariants | catalog 한 줄 추가로 가능 (구조 갖춰짐) |
| catalog hash 기반 archival staleness 감지 | 현재는 사용자 명시 `--fix` 재실행으로 충분. 자동화 시 ADR 갱신 |

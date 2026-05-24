# Data Integrity Checks — 선언적 invariant 카탈로그

**Status:** draft (2026-05-24)

## 1. Goal

캡처된 Stock-Date의 데이터가 도메인 불변값을 깨면 — 예를 들어 `regular_session_close_ms == 0`이라 `close < open`이 되는 경우 — 차트 read-path는 그 결함을 감지하지 못하고 통과시킨다. 결과는 `lightweight-charts`의 `setData`가 `"data must be asc ordered by time"` assertion으로 터지고, 사용자에게는 정체불명의 차트 실패로 보인다 (실제 발생: 2026-05-24 003490/20260518, hogaplay upstream이 stagnation으로 부분 응답 → close=0 박힘 → segment의 virtualStart가 다음 segment보다 큰 값 → 데이터 역행).

본 spec은 데이터 무결성을 **선언적 invariant 카탈로그**로 정의하고, 그 카탈로그가 4계층(parser write-time / DiskState classify / read-path bundle / CLI sweep)에서 일관되게 사용되도록 구조화한다. 새로 만드는 것이 아니라, 이미 존재하는 [`disk_state.py`](../../hoga/api/disk_state.py)의 분류 시스템(ADR-0007)을 invariants가 한 단계 더 받쳐주는 구조다.

## 2. Non-goals

| 항목 | 이유 |
|---|---|
| 자동 데이터 정리/삭제 | 사용자 데이터는 절대 자동 삭제 X. `hoga validate`는 read-only, `--fix`도 archival 필드 갱신만. |
| 재캡처 자동 트리거 | `INVALID` 감지 시 알아서 다시 캡처하지 않음. 사용자가 의도적으로 enqueue. |
| 시계열 invariants | candles 단조성, snapshot 갭 등은 다음 PR. MVP는 meta-level만 (검증 비용 vs 가치 균형). |
| 프론트엔드 surfacing UI | 백엔드가 `excluded_dates`/`data_warnings` 필드 노출만. UI 표시는 별 spec. |
| 시그니처-기반 데이터 위/변조 감지 | 본 spec은 의미적 무결성(domain invariants). 디스크 손상이나 외부 변조는 별 차원. |

## 3. 합의된 결정

| 항목 | 결정 |
|---|---|
| 카탈로그 위치 | `hoga/api/invariants.py` 단일 모듈 |
| Invariant 표현 | 순수함수 + 메타데이터(id, severity, description) 데이터클래스 |
| Severity 등급 | `error` (제외), `warn` (포함 + surfacing) 두 단계 |
| Read-path error 정책 | **조용히 제외 + 응답 메타에 `excluded_dates` 기록** |
| Read-path warn 정책 | **포함하되 응답 메타에 `data_warnings` 기록** |
| 평가 시점 | **매 호출마다 live 평가** (meta dict가 입력) |
| 과거 데이터 마이그레이션 | 불필요 — live 평가 덕분에 self-healing |
| `DiskState` 확장 | 새 상태 `INVALID` 한 개 추가 |
| Classify 우선순위 | `CLIENT_INCOMPLETE` > `INVALID` > `SOURCE_PARTIAL` / `COMPLETE` |
| L1 parser hook | meta.json에 `invariant_violations` 필드 archival 기록 (정상이면 필드 없음) |
| L4 sweep CLI | `hoga validate [--code C] [--severity error\|warn\|all] [--fix]`, read-only by default |
| MVP 카탈로그 크기 | 5개 (close_after_open, open_in_kst_range, close_in_kst_range, collection_finished, unique_events_ratio) |
| 응답 호환성 | 새 필드 기본값 빈 리스트 → 기존 클라이언트 무영향 |
| ADR | ADR-0020 — invariants 카탈로그가 DiskState의 입력 단계라는 책임 경계 명시 |

## 4. 아키텍처

### 4.1 모듈 경계

```
hoga/api/invariants.py    ← 새 모듈, 알맹이
hoga/api/disk_state.py    ← DiskState.INVALID 추가 + classify_from_meta 확장
hoga/api/bundle.py        ← build_range_bundle에서 INVALID 제외 + warn surfacing
hoga/api/models.py        ← RangeBundle에 excluded_dates / data_warnings 필드
hoga/parser/__init__.py   ← meta.json 쓰기 직전 archival hook
hoga/cli.py               ← validate 커맨드 추가
```

원칙: invariants 모듈은 다른 모듈을 import하지 않는다 (`meta: dict`만 받는 순수함수). 의존 방향은 단방향 (`bundle/disk_state/parser/cli` → `invariants`).

### 4.2 핵심 타입

```python
# hoga/api/invariants.py

class Severity(str, Enum):
    error = "error"
    warn = "warn"

@dataclass(frozen=True)
class Violation:
    invariant_id: str
    severity: Severity
    message: str
    ctx: dict             # 위반 시점의 관련 값 — 재현 가능하도록

    def as_dict(self) -> dict:
        return {
            "invariant_id": self.invariant_id,
            "severity": self.severity.value,
            "message": self.message,
            "ctx": self.ctx,
        }

@dataclass(frozen=True)
class Invariant:
    id: str
    severity: Severity
    description: str
    check: Callable[[dict], Violation | None]

INVARIANTS: tuple[Invariant, ...] = (...)   # §5 참조

def check(meta: dict) -> list[Violation]:
    """모든 invariant를 meta dict에 적용. 위반 목록 반환 (빈 리스트 = 무결)."""
    return [v for inv in INVARIANTS if (v := inv.check(meta)) is not None]
```

### 4.3 DiskState 확장

```python
# hoga/api/disk_state.py
class DiskState(Enum):
    NONE = "none"
    CLIENT_INCOMPLETE = "client_incomplete"
    SOURCE_PARTIAL = "source_partial"
    INVALID = "invalid"          # ← 새로 추가
    COMPLETE = "complete"

def classify_from_meta(meta: dict[str, object]) -> DiskState:
    # 1. 캡처 미완료가 가장 근본 결함 → 먼저 처리 (5/18 케이스가 여기서 이미 잡힘)
    if not meta.get("collection_complete", False):
        return DiskState.CLIENT_INCOMPLETE

    # 2. invariants live 평가 — error가 있으면 INVALID
    from hoga.api.invariants import check, Severity
    violations = check(meta)
    if any(v.severity == Severity.error for v in violations):
        return DiskState.INVALID

    # 3. warn은 DiskState에 영향 X (read-path가 별도 surfacing)
    is_partial = bool(meta.get("is_partial", True))
    return DiskState.SOURCE_PARTIAL if is_partial else DiskState.COMPLETE
```

**우선순위 근거**: `CLIENT_INCOMPLETE`가 `INVALID`보다 먼저 — "캡처가 안 끝나서 close=0이 박힌" 케이스는 invariants 평가까지 안 가도 잡힌다. invariants는 "캡처는 끝났는데 데이터가 이상한" 더 미묘한 케이스 전용.

### 4.4 Read-path 통합

```python
# hoga/api/bundle.py — build_range_bundle 내부 루프
for d in dates:
    meta = engine.get_meta(d, code)
    state = classify_from_meta(meta)

    if state == DiskState.INVALID:
        errors = [v for v in invariants.check(meta) if v.severity == Severity.error]
        excluded.append(ExcludedDate(date=d, violations=[v.as_dict() for v in errors]))
        continue                              # segment 빌드 skip

    # COMPLETE / SOURCE_PARTIAL → 포함, warn만 surfacing
    warns = [v for v in invariants.check(meta) if v.severity == Severity.warn]
    if warns:
        warnings.append(DateWarning(date=d, warnings=[v.as_dict() for v in warns]))

    # ... 기존 segment / candles / ratio_pts / fill_pts / profiles_by_day 빌드 ...

if not segments:
    raise HTTPException(404, {
        "detail": "all Stock-Dates excluded by invariants",
        "excluded": [e.as_dict() for e in excluded],
    })
```

**모범 단방향**: `classify_from_meta`는 "포함/제외 판단"만, `invariants.check`는 "왜?"만 — 두 호출 책임 분리. eligibility/calendar 엔드포인트는 분류만 필요해서 위반 디테일 직렬화 비용을 안 짊어진다 (단일 책임 + 게으른 평가).

### 4.5 응답 모델 확장

```python
# hoga/api/models.py
class ExcludedDate(BaseModel):
    date: str
    violations: list[dict]   # [{invariant_id, severity, message, ctx}, ...]

class DateWarning(BaseModel):
    date: str
    warnings: list[dict]

class RangeBundle(BaseModel):
    # ... 기존 필드 ...
    excluded_dates: list[ExcludedDate] = []
    data_warnings: list[DateWarning] = []
```

기본값 빈 리스트라 기존 클라이언트 무영향 (Pydantic 직렬화에서 빈 리스트도 포함되지만 의미적으로 noop).

### 4.6 Parser write-time hook (L1)

```python
# hoga/parser/__init__.py — meta.json 쓰기 직전
from hoga.api.invariants import check
violations = check(meta)
if violations:
    meta["invariant_violations"] = [v.as_dict() for v in violations]
# else: 필드 자체를 안 박음 (정상 데이터에 noise 0)
```

**Archival-only**: read-path는 어차피 live로 재평가 (self-healing) → 이 hook의 역할은 "그 시점의 평가 기록"을 남기는 것뿐. 나중에 "이 결함은 언제 처음 감지됐나" 추적 + L4 sweep 캐시 활용.

### 4.7 CLI sweep (L4)

```python
# hoga/cli.py
@app.command()
def validate(
    code: str | None = typer.Option(None, help="단일 Code로 좁히기"),
    severity: str = typer.Option("error", help="error | warn | all"),
    fix: bool = typer.Option(False, help="archival 필드만 재기록 (데이터 수정 X)"),
) -> None:
    """Walk all parquet Stock-Dates and report invariant violations."""
```

특징:
- **읽기만** 기본. `--fix`는 archival 필드 갱신만 — 데이터 자체 수정/삭제 X.
- **Idempotent** — 같은 meta에 대해 결정론적. CI에서 매일 돌려도 무방.
- `--code` 필터 — 한 종목만 빠르게 점검 (저장소 수천 개 시점 대비).

`--fix`의 의미: "데이터를 고치는" 게 아니라 "현재 평가 결과를 meta.json에 다시 박는" 것. 카탈로그 업데이트 후 (예: 새 invariant 추가) 과거 데이터에 그 필드를 일관되게 채워두고 싶을 때만 사용. 데이터 자체의 결함 수정은 **재캡처**가 유일한 길이며 항상 사용자의 명시적 결정.

## 5. MVP 카탈로그 (5개)

`hoga/api/invariants.py`에 등록.

### error 등급 — 데이터 형태 자체가 깨짐. read-path에서 제외.

| ID | 검사 | 5/18 케이스 매칭 |
|---|---|---|
| `meta.close_after_open` | `close_ms > open_ms` | ✓ (close=0 < open=90000000) |
| `meta.open_in_kst_range` | `14400000 ≤ open_ms ≤ 43200000` (04:00–12:00 KST) | — (open=90000000 정상) |
| `meta.close_in_kst_range` | `43200000 ≤ close_ms ≤ 64800000` (12:00–18:00 KST) | ✓ (close=0 outside) |

### warn 등급 — 데이터 모양은 맞으나 신뢰도 낮음. 포함하되 surfacing.

| ID | 검사 | 5/18 케이스 매칭 |
|---|---|---|
| `collection.finished` | `collection_complete == True` | ✓ (false) |
| `collection.unique_events_ratio` | `total_unique_events ≥ max(10, pages_collected // 2)` | ✓ (1553 < 4132/2 = 2066) |

**5개 모두 5/18 003490 케이스를 잡는다.** 향후 확장을 위해 ID에 `meta.` / `collection.` prefix를 둠 — 나중에 `series.candles_monotonic`, `series.snapshots_gap` 같은 invariant 추가 자리 예약.

## 6. 테스트 전략

| 계층 | 위치 | 케이스 |
|---|---|---|
| **단위** | `tests/hoga/api/test_invariants.py` (신규) | 5개 invariant × {정상, 위반} = 10 케이스 + `check()`의 정상/위반 집계. meta dict 인라인 fixture, 외부 의존 0. |
| **DiskState 통합** | `tests/hoga/api/test_disk_state.py`에 추가 | `INVALID` 새 분기 진입 + 우선순위 (`CLIENT_INCOMPLETE` > `INVALID`) + warn이 DiskState에 영향 없음 |
| **Bundle E2E** | `tests/test_api_range.py`에 추가 | 깨진 meta 1 + 정상 meta 2 fixture → bundle에서 깨진 게 제외되고 `excluded_dates` surfacing. warn-only fixture → 포함되되 `data_warnings` 채워짐. 전부 invalid → 404. |
| **CLI** | `tests/test_cli.py`에 추가 | `hoga validate` 호출 → 깨진 dir 보고. `--fix` 멱등성. `--code` 필터. |
| **Regression** | 위 모든 계층에 5/18 003490 실제 meta dict를 fixture로 박음 | 미래에 누가 카탈로그를 만지더라도 이 케이스가 깨지면 CI 즉시 실패 |

**Property-based (MVP 외, 다음 PR 후보)**: Hypothesis로 "임의 meta dict → check가 결정론적, 부작용 없음, 카탈로그 순서 무관" 검증. 카탈로그가 커지면 가치 큼.

## 7. 마이그레이션 / 호환성

- **과거 meta.json**: 마이그레이션 불필요. `classify_from_meta`가 live 평가하므로 `invariant_violations` 필드 부재는 무영향.
- **API 응답 클라이언트**: 새 필드 (`excluded_dates`, `data_warnings`) 기본값 빈 리스트. 기존 클라이언트는 Pydantic의 forward-compat 직렬화로 무영향.
- **`DiskState.INVALID` 신규 값**: 기존 `DiskState` 소비자 (eligibility, calendar)는 enum 비교만 하므로 새 값을 만나면 자연스레 default 분기로 가지만, 의미적으로 처리되어야 함:
  - `eligibility.decide_capture`: `INVALID` → resume=False, fresh capture 진행 (CLIENT_INCOMPLETE와 동일 분기). 별도 `INVALID` 분기 추가는 다음 PR (재캡처 정책 결정 필요).
  - `calendar._disk_state_to_status`: `"invalid"` 매핑 추가. 캘린더 셀 색 결정은 프론트엔드 디자인 영역(`DESIGN.md` 토큰 참조) — 본 spec은 status 문자열만 노출.
- 두 소비자 모두 본 PR 범위에 포함 (도메인 일관성).

## 8. 작업 순서 (구현 plan의 시드)

1. `hoga/api/invariants.py` 신규 + 카탈로그 5개 + 단위 테스트
2. `hoga/api/disk_state.py`에 `INVALID` + `classify_from_meta` 확장 + 통합 테스트
3. `hoga/api/eligibility.py`, `hoga/api/calendar.py`에 `INVALID` 분기 매핑 추가
4. `hoga/api/models.py`에 `ExcludedDate`, `DateWarning`, `RangeBundle` 확장
5. `hoga/api/bundle.py`의 `build_range_bundle` 루프 수정 + E2E 테스트
6. `hoga/parser/__init__.py`에 archival hook
7. `hoga/cli.py`에 `validate` 커맨드 + CLI 테스트
8. ADR-0020 작성
9. 5/18 003490 케이스로 end-to-end 검증 (재캡처해서 L1이 violation 박는지, read-path가 제외하는지)

## 9. 미해결 / Follow-up

| 항목 | 다음 단계 |
|---|---|
| 시계열 invariants | 별 PR — candles 단조성, snapshot 갭, cum_vol 일관성 등. `Invariant` 타입 그대로 재사용 가능. |
| `INVALID` 만난 eligibility의 재캡처 정책 | 본 PR은 "fresh capture 진행"으로 시작. 사용자 피드백 받아 force-prompt UX 등 결정. |
| 프론트엔드 `excluded_dates`/`data_warnings` 표시 | 차트 위에 배지/툴팁. 별 spec. |
| Property-based 테스트 | Hypothesis 도입 시 추가. 카탈로그 10개 넘어가면 가치 큼. |
| Sweep 결과 영속화 | 현재는 CLI 출력만. 향후 `~/.local/share/hoga-ops/integrity-report.json` 같은 영속 저장소 가능. |

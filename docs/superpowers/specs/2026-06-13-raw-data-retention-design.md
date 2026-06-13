# Raw Data Retention / Prune — Design

**Date**: 2026-06-13
**Status**: Approved
**Scope**: `hoga/api/prune.py` (신규), `hoga/cli.py`, `hoga/api/scheduler.py`, `hoga/api/disk_state.py` (재사용만), `tests/test_api_prune.py` (신규)

## Problem

`data/raw/YYYYMMDD/<code>/first_NNNNN.tsv` (비압축 틱 호가 TSV)가 **무한 누적**되어
2026-06-13 디스크가 100%에 도달했다 (raw 704GB / 937GB 디스크의 75%). 사용자 표현:

> "왜 저렇게 raw 저장되고, 삭제관리가 안 되는지도 체크가 필요"

근본 원인 (조사 결과):

- **정리 단계 부재**: capture → parse → parquet 파이프라인에 raw를 정리하는 코드/명령/스케줄이
  **하나도 없다**. CLI는 `collect`/`parse`/`serve`/`screener-*`만 존재하고 `parse`는
  raw를 소비하되 삭제하지 않는다 (`hoga/cli.py:61-80`).
- **의도적 보존 + 규모 미설계**: raw는 ADR-0019에서 resume/재parse용 "원천(SSOT)"으로
  의도적으로 보존하지만, **크기 상한·TTL·정리 시점은 어떤 ADR/CONTEXT에도 규정된 적이 없다**.
- **트리거**: 관심종목 41→235개(약 6배) 확대로 일일 raw가 6GB→34GB로 급증.
- **재사용 없음**: parse 이후 raw의 소비처는 ① `parse` 입력 ② `disk_state` 존재 체크뿐이고,
  parse가 끝나면 사실상 다시 읽히지 않는다 (사용자 확인: "거의 없다 — parquet이면 충분").

기존 704GB는 2026-06-13에 수동으로 698GB를 안전 삭제(parquet 변환 완료분)했다. 이 spec은
**재발 방지** — 즉 앞으로 raw가 다시 무한 누적되지 않도록 자동/수동 정리 메커니즘을 추가한다.

## Invariants

이 spec이 건드리는(혹은 의존하는) 시스템이 현재 보존하는 속성들:

- **Parquet-first 분류 투명성**: `check_disk_state`는 parquet meta.json을 raw glob보다
  먼저 평가하므로, parquet이 있는 (date,code)의 raw 디렉터리를 삭제해도 그 (date,code)의
  `DiskState` 분류는 바뀌지 않는다. 근거: `hoga/api/disk_state.py:180-216` (resolution
  order 0→1→2; raw glob은 step 2, parquet meta는 step 1).
- **Resume 소스 보존**: `CLIENT_INCOMPLETE`(`collection_complete=False`) 상태의 raw는
  다음 캡처가 커서부터 이어받는 resume 입력이다. 삭제하면 처음부터 재캡처해야 한다.
  근거: `hoga/api/disk_state.py:103-104`, `hoga/collector/orchestrator.py:77-85` (`raw_pages`).
- **COMPLETE = 유일한 source-of-truth**: 사용자/watchlist 관점에서 `SOURCE_PARTIAL`과
  `CLIENT_INCOMPLETE`는 "in-flight"(진행 중)이고 `COMPLETE`만 확정 상태다.
  근거: `hoga/api/disk_state.py:144-145` (`latest_complete_date` docstring).
- **Capture-prune 시간 분리**: 일일 capture는 항상 `today`(KST)를 대상으로 하고
  (`hoga/api/scheduler.py:71-89`), prune은 `today − N`일 이전만 건드린다 → 진행 중인
  캡처/parse와 prune이 같은 (date,code)를 동시에 만지지 않는다.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Parquet-first 분류 투명성 | **preserves** | prune은 raw만 삭제, parquet/meta.json 미접촉 → 분류 입력 step 1 불변 |
| Resume 소스 보존 | **preserves** | 게이트가 `COMPLETE`만 삭제 → `CLIENT_INCOMPLETE` raw는 보존 |
| COMPLETE = source-of-truth | **preserves** | `SOURCE_PARTIAL`·`CLIENT_INCOMPLETE`·`INVALID`·`NO_UPSTREAM_DATA` 전부 보존 |
| Capture-prune 시간 분리 | **preserves** | 유예 N(≥1)일이 곧 race guard. `--days 0`은 CLI 검증으로 차단 |

이 spec은 기존 시스템 속성을 깨지 않는다 — 새 정리 분기를 **가장 보수적인 게이트**
(`DiskState.COMPLETE` + `date < today−N`)로 추가하며, 모든 in-flight/불완전 상태를 보존한다.

## Goals

- raw 디스크 점유를 **bounded** 상태로 유지: 정상 운영 시 raw는 최근 ~N일치(기본 3일,
  ≈ N × 일일 raw)만 존재.
- **자동 + 수동** 병행: scheduler가 매일 1회 자동 정리, `hoga prune` CLI로 수동/임시 정리.
- **무손실 보장**: `COMPLETE`(parquet 확정 + invariant error 없음)인 raw만 삭제 →
  복구 불가능한 데이터(resume 소스, 미완성, 갭 있는 partial)는 절대 안 건드림.
- **관측 가능**: 자동 경로는 무인 삭제이므로 매 실행 회수 개수·바이트를 로그로 남김.

## Non-Goals

- **압축 보관**: zstd 압축은 별도 옵션(사용자가 "거의 없다 — parquet이면 충분" 선택).
- **비-COMPLETE raw 정리**: `SOURCE_PARTIAL`/`CLIENT_INCOMPLETE`/parse 영영 실패분은
  보존한다 (Risks 참조).
- **기존 누적분 일괄 삭제**: 2026-06-13에 수동 처리 완료. 이 spec은 재발 방지만.
- **parquet/meta 정리**: parquet은 SSOT라 건드리지 않는다.
- **백엔드 알림/대시보드**: 디스크 사용량 알림 UI는 범위 밖.

## Design

### 모듈 — `hoga/api/prune.py` (순수 로직, 부작용 분리)

```python
@dataclass(frozen=True)
class PruneCandidate:
    date: str          # YYYYMMDD
    code: str
    raw_dir: Path
    size_bytes: int    # 회수 예상량 (dry-run 표시용)

@dataclass(frozen=True)
class PruneResult:
    candidates: list[PruneCandidate]   # 삭제 대상(또는 dry-run 후보)
    deleted: int                       # 실제 삭제한 개수 (dry-run이면 0)
    reclaimed_bytes: int               # 실제 회수 바이트 (dry-run이면 0)
    scanned: int                       # 순회한 (date,code) 총수

def find_prunable(
    data_dir: Path, *, retention_days: int, now: datetime
) -> list[PruneCandidate]:
    """raw/ 순회 → 날짜 컷오프 통과 + DiskState.COMPLETE인 (date,code)만 반환. 부작용 없음."""

def prune_raw(
    data_dir: Path, *, retention_days: int, now: datetime, execute: bool
) -> PruneResult:
    """find_prunable 호출 후 execute=True면 rmtree. 빈 날짜 디렉터리도 정리."""
```

- `find_prunable`이 순수 함수라 단위 테스트가 디렉터리 픽스처만으로 가능.
- 순회 패턴은 기존 `hoga/cli.py:143-163`(`raw_root.iterdir()` + `is_dir()` 가드)을 따른다.

### 삭제 게이트 (안전의 핵심)

각 raw `(date, code)`에 대해:

1. **날짜 컷오프**: `date < cutoff` where
   `cutoff = (now_kst().date() − timedelta(days=retention_days)).strftime("%Y%m%d")`.
   YYYYMMDD lexical 비교 (선례: `disk_state.py:160`).
2. **상태 게이트**: `check_disk_state(data_dir, code, date).state == DiskState.COMPLETE`.
   `COMPLETE`만 통과 → `SOURCE_PARTIAL`/`CLIENT_INCOMPLETE`/`INVALID`/`NO_UPSTREAM_DATA`는
   전부 보존. 이 한 줄로 sentinel·미완성·갭·손상이 모두 자동 제외된다.

두 조건 AND를 만족하는 `(date, code)`의 `raw/{date}/{code}/`만 삭제 대상.

### CLI — `hoga prune` (dry-run 기본, `validate --fix` 관례)

```
hoga prune                 # dry-run: "would delete N dirs, ~X GiB" 출력만
hoga prune --execute       # 실제 삭제
hoga prune --days 7        # 유예 기간 override (기본 = HOGA_RETENTION_DAYS, 그다음 3)
```

- `--days 0`은 거부(`typer.Exit(2)`) — Capture-prune 시간 분리 invariant 보호.
- 출력: dry-run은 `[yellow]dry-run[/yellow]`, 실행은 `[green]pruned[/green] N dirs, X GiB`.

### Scheduler 통합

`hoga/api/scheduler.py:_daily_run`의 **promotion 직후, 거래일 체크 전**(현 L69–71 사이)에:

```python
try:
    result = await asyncio.to_thread(
        prune_raw, data_dir, retention_days=RETENTION_DAYS, now=now_kst(), execute=True
    )
    log.info("daily prune: removed %d dirs, reclaimed %.1f GiB",
             result.deleted, result.reclaimed_bytes / 1024**3)
except Exception:  # noqa: BLE001 — prune 실패가 enqueue를 막으면 안 됨
    log.exception("daily run: prune failed; continuing")
```

- **promotion 직후 배치 이유**: 거래일 체크 뒤에 두면 주말/휴장일에 skip되어 "매일 1회"가
  깨진다. promotion처럼 "scheduler 소유, 큐 무관" 작업이다 (ADR-0034 무충돌 — 큐 미접촉).
- `asyncio.to_thread`: `rmtree`는 blocking I/O이고 scheduler는 live poller와 이벤트 루프를
  공유하므로 절대 루프에서 직접 돌리지 않는다 (선례: `scheduler.py:74-76`).

### 설정 — `HOGA_RETENTION_DAYS` env (기본 3)

```python
# hoga/api/prune.py 최상단
RETENTION_DAYS_DEFAULT = 3
RETENTION_DAYS = int(os.environ.get("HOGA_RETENTION_DAYS", RETENTION_DAYS_DEFAULT))
```

- `Config`는 frozen이라 수정하지 않고, 모듈 상수 + env override 패턴을 쓴다
  (선례: `resolve_data_dir`의 `HOGA_DATA_DIR`). `.env`는 app lifespan에서 이미 로드됨.

## Testing

### Unit tests (`tests/test_api_prune.py`)

`tests/conftest.py`의 `tmp_data_dir` 픽스처 + `test_api_disk_state.py`의 `_write_meta` 헬퍼 재사용.

| Case | Setup | Expected |
|------|-------|----------|
| 오래된 COMPLETE 삭제 | `date=today−5`, parquet meta `complete=True, partial=False`, raw 존재 | raw 삭제, parquet 보존 |
| 유예 내 COMPLETE 보존 | `date=today−1`(N=3), COMPLETE, raw 존재 | raw 보존 (컷오프 미통과) |
| SOURCE_PARTIAL 보존 | `date=today−5`, meta `complete=True, partial=True` | raw 보존 |
| CLIENT_INCOMPLETE 보존 | `date=today−5`, meta `complete=False` | raw 보존 (resume 소스) |
| INVALID 보존 | `date=today−5`, meta가 error invariant 유발 | raw 보존 |
| NO_UPSTREAM sentinel 보존 | `date=today−5`, `.no_upstream_data` 존재 | raw 보존 |
| parquet 없는 raw 보존 | `date=today−5`, raw만 존재(meta 없음) | raw 보존 (CLIENT_INCOMPLETE) |
| dry-run 무삭제 | 삭제 대상 존재, `execute=False` | `deleted=0`, 후보만 반환, 디스크 불변 |
| 빈 날짜 디렉터리 정리 | 날짜 내 모든 code 삭제 후 | 빈 `raw/{date}/` 제거 |
| `--days 0` 거부 | CLI `--days 0` | `typer.Exit(2)`, 삭제 없음 |
| reclaimed_bytes 정확성 | 알려진 크기 raw 삭제 | `reclaimed_bytes == 실제 du` |

**Invariant 회귀 테스트**: 위 "보존" invariant 각각이 테이블의 보존 케이스(SOURCE_PARTIAL/
CLIENT_INCOMPLETE/INVALID/sentinel/유예내)로 직접 검증된다. "Parquet-first 투명성"은
"오래된 COMPLETE 삭제" 케이스에서 삭제 후 `check_disk_state(...) == COMPLETE`가 유지됨을 단언.

### Manual verification

- `hoga prune`(dry-run)을 실제 데이터에 실행 → 후보 목록·예상 회수량이 합리적인지 육안 확인.
- `hoga prune --execute` 후 `check_disk_state` 결과 불변 + `/api/symbols`(disk_state 소비)
  정상 응답 확인.
- scheduler 자동 경로는 다음 일일 실행 후 로그에 "daily prune: removed N dirs" 확인.

## Risks / Open questions

- **비-COMPLETE raw 누적**: COMPLETE-only 게이트라 `SOURCE_PARTIAL`(~4.5%)·
  `CLIENT_INCOMPLETE`(~5.3%, 2026-06-13 소급 측정)인 raw는 영영 안 지워진다. parse가 영영
  실패해 COMPLETE에 도달 못 하는 stock-date의 raw도 마찬가지. 일일 raw의 ~10%가 잠재 누적
  대상 → 절대량은 작지만(과거 698GB 대비 훨씬 느림) **prune만으로 디스크 상한이 보장되지는
  않는다**. 누적이 문제가 되면 `--include-partial` 옵트인 또는 별도 진단/재처리로 후속 대응.
- **유예 기간 튜닝**: 기본 3일은 "parse 직후 며칠 내 문제 발견 시 재parse 여유"를 가정.
  실제 운영에서 짧거나 길면 `HOGA_RETENTION_DAYS`로 조정.
- **per-source 레이아웃 (ADR-0037)**: `check_disk_state`가 이미 per-source meta를
  집계하므로 게이트는 그대로 동작. sentinel 위치(raw vs parquet)가 ADR-0037로 이동 중이면
  `check_disk_state`가 흡수하므로 prune 로직 변경 불필요.

## Out of Scope (Backlog)

- **zstd 압축 보관**: 원본을 장기 보존하고 싶을 때의 대안 (705G→~90G). 현재는 불채택.
- **`--include-partial` / `--include-incomplete`**: 더 공격적인 정리 옵트인.
- **디스크 사용량 알림**: 임계치 초과 시 알림/대시보드.
- **parse 영영 실패 stock-date 진단**: COMPLETE 미도달 raw를 찾아 재처리/폐기하는 별도 도구.

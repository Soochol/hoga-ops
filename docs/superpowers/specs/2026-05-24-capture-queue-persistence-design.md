# Capture Queue Persistence — 서버 재시작 후 자동 큐 재개

**Status:** draft (2026-05-24)

## 1. Goal

`/capture` 큐에 (code, date) 짝을 enqueue 해놓고 진행 중에 서버가 재시작하면 — 의도적인 재배포든, 크래시든, OS reboot이든 — 큐 전체가 메모리에서 사라진다. 사용자는 큐에 무엇이 있었는지 기억해서 수동으로 다시 입력해야 한다.

본 spec은 큐 매니페스트를 디스크에 영속화해서, **서버 부팅 시 워커가 자동으로 이전 세션의 큐를 이어서 처리**하도록 한다. 이미 디스크에 남아있는 원시 페이지(`first_NNN.tsv`)와 `_progress.json` 커서를 활용해서, 진행 중이던 stock-date는 멈춘 지점부터 resume된다 (CLIENT_INCOMPLETE → `resume=True` 라우팅).

## 2. Non-goals

| 항목 | 이유 |
|---|---|
| Done 리스트 영속화 | 휘발성. 사용자가 `DELETE /done`으로 언제든 비울 수 있는 상태와 일관성 유지. §11에 별도 follow-up. |
| Capture 히스토리 영구 보존 | §11 "capture history view"의 별개 feature. SQLite 기반으로 풀어야 함. |
| 다중 워커/프로세스 동기화 | 본 도구는 단일 uvicorn worker 가정 ([hoga/api/captures.py:54](hoga/api/captures.py#L54)). 매니페스트도 단일 reader/writer 전제. |
| `_max_concurrent` 영속화 | 환경 변수 기반 설정값. 매니페스트는 큐 *내용*만 다룸. |
| UI 변경 | 자동 재개라 사용자에게 보이는 새 UI 요소 없음. |

## 3. 합의된 결정

| 항목 | 결정 |
|---|---|
| 영속 포맷 | JSON, `<data_dir>/.queue.json` (dotfile). 위치 근거는 [§3.1](#31-위치-asymmetry-vs-adr-0015). |
| 원자성 | 공유 헬퍼 `hoga/api/_atomic_write.py::atomic_write_json` (tempfile + flush + fsync + os.replace) |
| 스키마 필드 | `schema_version: int = 1` (ADR-0015 convention) |
| Write 빈도 | 큐 mutation마다 동기 write (lock 안에서) |
| Write 실패 | `OSError` catch → WARN 로그 → propagate 안 함. 인메모리 상태가 런타임 진실의 원천. |
| 복원 시 phase | 전부 `"queued"`로 재시작. `decide_capture`가 디스크 보고 resume/skip/fresh 알아서 라우팅. |
| 재시작 동작 | **자동 재개** — 워커가 부팅 후 큐를 보고 즉시 처리 |
| Done 복원 | 안 함 |
| 손상 매니페스트 | 백업(`.queue.json.corrupt-<ts>-<reason>`) + 빈 큐로 시작 + WARN 로그 |
| 새 SSE 이벤트 | 불필요. 기존 `capture_phase` / `capture_progress` 이벤트가 복원된 아이템에도 그대로 흐름 |
| SSE disconnect 핸들러 | [frontend/src/api/sse.ts:80-82](frontend/src/api/sse.ts#L80-L82) 확장 — `CAPTURE_QUEUE_QUERY_KEY` + `CALENDAR_QUERY_KEY` 도 invalidate. 자동 재개 UX 완성 필수. |
| ADR | ADR-0019 (queue manifest persistence) — 위치 비대칭 + auto-resume + don't-persist-done 근거 보존 |

### 3.1 위치 asymmetry vs ADR-0015

ADR-0015는 Symbol Master를 `~/.local/share/hoga-ops/symbol-master.json`(XDG)에 두기로 결정했다 — "worktree를 넘어서는 글로벌 KRX 메타데이터"라는 이유. 본 spec은 **반대로 `<data_dir>/.queue.json`을 선택**한다:

- 큐 아이템은 (Code, Stock-Date) 짝을 가리키고, 그 짝의 raw 페이지(`first_NNN.tsv`)는 **data_dir에 있다**. 매니페스트가 가리키는 디스크 상태와 매니페스트 자체가 같은 디렉토리에 있어야 일관됨.
- 두 worktree가 서로 다른 data_dir을 쓰면 각자의 큐가 있어야 한다 — 글로벌 위치는 잘못된 공유를 만듦.
- `git clean -fdx`나 data_dir 통째 삭제 시 큐도 함께 사라지는 게 **올바른 동작** (의존하는 raw 페이지도 함께 사라지므로).

ADR-0019에 이 asymmetry를 명시한다.

## 4. 아키텍처

### 4.1 모듈 경계

```
hoga/api/
  captures.py                  ← 기존, _persist_queue_locked() 추가
  captures_persistence.py      ← 신규, save/load/quarantine
  _atomic_write.py             ← 신규, atomic_write_json() 공유 헬퍼
  symbols.py                   ← 기존, _write_to_disk가 _atomic_write 사용하도록 마이그레이션
  models.py                    ← 기존, QueueManifest, QueueManifestItem 추가
```

**Dependency 방향:**
- `captures_persistence.py` → `_atomic_write.py`, `models.QueueManifest`
- `captures.py` → `captures_persistence.py` (단방향, 양방향 import 회피)
- `symbols.py` → `_atomic_write.py` (마이그레이션 — 기존 인라인 코드 대체)

`_atomic_write.py`는 ADR-0015 footer가 명시적으로 예고한 추출 — 두 번째 persistence 타깃이 등장한 시점이므로 "two-adapters rule"에 따라 추출한다.

### 4.2 Wire 모델 ([hoga/api/models.py](hoga/api/models.py))

```python
class QueueManifestItem(BaseModel):
    item_id: str
    code: str
    date: str
    force_retry: bool
    enqueued_at_ms: int
    pause_origin: bool

class QueueManifest(BaseModel):
    schema_version: int = 1
    paused: bool
    items: list[QueueManifestItem]
```

저장하지 않는 필드와 이유:

| 필드 | 이유 |
|---|---|
| `phase` | 복원 시 항상 `queued`로 강제 |
| `started_at_ms` | 재캡처 시 새로 stamp |
| `pages_done`, `events_seen`, `frontier`, `elapsed_ms`, `estimate_pct` | `_progress.json`이 진실의 원천. 복원 시 `_resume_state`가 디스크 읽어 재구성 |
| `result`, `error`, `skip_reason` | terminal 상태. done에만 들어가는데 done은 영속화 안 함 |
| `cancel_token` | 런타임 객체. asyncio.Event 포함, 직렬화 불가 |

### 4.3 공유 atomic-write 헬퍼

[hoga/api/_atomic_write.py](hoga/api/_atomic_write.py) (신규):

```python
"""Atomic JSON write. Extracted per ADR-0015 footer + ADR-0019."""
import json
import os
import tempfile
from pathlib import Path
from typing import Any

def atomic_write_json(path: Path, payload: Any, *, indent: int = 2) -> None:
    """Write `payload` as JSON to `path` atomically.

    Pattern: tempfile in target's parent dir → flush + fsync → os.replace.
    Raises OSError on disk-write failure; callers decide whether to propagate.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=indent)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)
```

[hoga/api/symbols.py](hoga/api/symbols.py)의 `_write_to_disk`도 이 헬퍼를 사용하도록 마이그레이션 — payload dict 구성은 그대로, atomic 부분만 위임. 회귀 위험 낮음 (동일 코드 패턴).

### 4.4 Persistence 모듈

[hoga/api/captures_persistence.py](hoga/api/captures_persistence.py) (신규):

```python
from pathlib import Path
import logging
from pydantic import ValidationError
from hoga.api.models import QueueManifest
from hoga.api._atomic_write import atomic_write_json
from hoga.collector.orchestrator import now_kst

logger = logging.getLogger(__name__)
MANIFEST_FILENAME = ".queue.json"
_SCHEMA_VERSION = 1

def manifest_path(data_dir: Path) -> Path:
    return data_dir / MANIFEST_FILENAME

def save_manifest(data_dir: Path, manifest: QueueManifest) -> None:
    """Atomic write. Caller holds _lock. OSError is caught + logged here so
    that disk failures don't break in-memory queue operations.
    """
    try:
        atomic_write_json(manifest_path(data_dir), manifest.model_dump(mode="json"))
    except OSError as e:
        logger.warning(
            "queue manifest write failed (%s); in-memory queue continues, "
            "restart recovery may lose state", e,
        )

def load_manifest(data_dir: Path) -> QueueManifest | None:
    """None if missing. Quarantine + None on corrupt or version mismatch."""
    target = manifest_path(data_dir)
    if not target.exists():
        return None
    try:
        raw = target.read_text(encoding="utf-8")
        manifest = QueueManifest.model_validate_json(raw)
    except (OSError, ValueError, ValidationError) as e:
        _quarantine(target, reason=f"parse_error:{type(e).__name__}")
        return None
    if manifest.schema_version != _SCHEMA_VERSION:
        _quarantine(target, reason=f"version_mismatch_{manifest.schema_version}")
        return None
    return manifest

def _quarantine(path: Path, *, reason: str) -> None:
    ts = now_kst().strftime("%Y%m%dT%H%M%S")
    backup = path.with_name(f"{path.name}.corrupt-{ts}-{reason}")
    try:
        path.rename(backup)
        logger.warning("queue manifest quarantined: %s → %s", path, backup.name)
    except OSError as e:
        logger.warning("queue manifest quarantine rename failed: %s", e)
```

**중요:** `save_manifest`가 OSError를 자체 흡수하므로 `_persist_queue_locked` 호출부는 try/except를 둘 필요 없음. 큐 mutation이 disk failure로 인해 실패하지 않는다.

### 4.5 captures.py 통합

새 헬퍼 — **lock 보유 중에 호출**:

```python
def _persist_queue_locked() -> None:
    """Snapshot _queue + _active + _queue_paused to disk.

    INVARIANT: caller holds `_lock`. Called from every mutation site that
    touches _queue or _active. _done is intentionally excluded.
    """
    if _data_dir is None:
        return  # test fixture without data_dir wired
    items = [
        QueueManifestItem(
            item_id=s.item_id,
            code=s.code,
            date=s.date,
            force_retry=s.force_retry,
            enqueued_at_ms=s.enqueued_at_ms,
            pause_origin=s.pause_origin,
        )
        for s in (*_active.values(), *_queue)
    ]
    manifest = QueueManifest(paused=_queue_paused, items=items)
    save_manifest(_data_dir, manifest)
```

**Ordering invariant:** 매니페스트는 `_active` 아이템을 먼저, 그 다음 `_queue` 아이템을 저장한다. 복원 시 이 순서대로 `_queue.append`되므로 **이전 세션에서 capturing 중이던 아이템이 워커에게 가장 먼저 잡힌다** — 부분 fetch된 raw 페이지가 있어 즉시 resume 가능하므로 사용자가 체감하는 "이어서 진행" 효과가 가장 빠르게 나타남.

Write hook 지점 (모두 `_lock` 보유 중):

| 함수 | 위치 | 트리거 |
|---|---|---|
| `enqueue_items` ([captures.py:760](hoga/api/captures.py#L760)) | `_queue.append` 루프 후 | enqueue 성공 |
| `_worker_loop` ([captures.py:568-571](hoga/api/captures.py#L568-L571)) | `_active[state.item_id] = state` 직후 | queued → active 전환 |
| `_finalize_item` ([captures.py:436-453](hoga/api/captures.py#L436-L453)) | `_active.pop` + `_done.append` 후 | 아이템 완료 |
| `_handle_cookie_expired` ([captures.py:471-485](hoga/api/captures.py#L471-L485)) | `_queue_paused = True` 후 | 쿠키 만료 |
| `resume_queue` ([captures.py:488-505](hoga/api/captures.py#L488-L505)) | `_queue_paused = False` + 재큐 후 | 사용자 resume |
| `cancel_all` ([captures.py:508-545](hoga/api/captures.py#L508-L545)) | drain + cancel signal 후 | cancel-all |
| `cancel_item` (queued case, [captures.py:776-789](hoga/api/captures.py#L776-L789)) | `del _queue[i]` 후 | 개별 cancel (queued) |

**`cancel_item` active case는?** `cancel_token.cancel()`만 시그널 — 워커가 실제로 cancel을 관찰하면 `_finalize_item`에서 매니페스트 갱신됨. 별도 write 불필요.

또한 [hoga/api/captures.py:173-185](hoga/api/captures.py#L173-L185)의 `reset_state_for_tests`를 확장 — 매니페스트 파일도 삭제:

```python
def reset_state_for_tests() -> None:
    global _queue_paused, _wakeup
    _queue.clear()
    _active.clear()
    _done.clear()
    _inflight_paths.clear()
    _queue_paused = False
    _wakeup = None
    if _data_dir is not None:
        manifest_path(_data_dir).unlink(missing_ok=True)
```

이 없이는 pytest fixture가 worktree의 실제 매니페스트 파일을 건드릴 위험 — 또는 직전 테스트의 매니페스트가 다음 테스트로 새는 leak.

### 4.6 Startup 복원 ([hoga/api/app.py](hoga/api/app.py) lifespan)

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # ... existing wiring ...
    captures.set_bus(bus, asyncio.get_running_loop())
    _restore_queue_from_manifest(data_dir)   # NEW: BEFORE start_workers
    captures._workers = captures.start_workers()
    try:
        yield
    finally:
        captures.cancel_all_on_shutdown()
        await captures.stop_workers(captures._workers)


def _restore_queue_from_manifest(data_dir: Path) -> None:
    manifest = load_manifest(data_dir)
    if manifest is None:
        return
    captures._queue_paused = manifest.paused
    for item in manifest.items:
        state = QueueItemState(
            item_id=item.item_id,
            code=item.code,
            date=item.date,
            force_retry=item.force_retry,
            enqueued_at_ms=item.enqueued_at_ms,
            pause_origin=item.pause_origin,
            phase="queued",
        )
        captures._queue.append(state)
    logger.info(
        "restored queue manifest: %d items, paused=%s",
        len(manifest.items), manifest.paused,
    )
```

`start_workers()`보다 **먼저** 호출 — 워커가 시작되는 순간 `_queue`가 채워져 있으면 자연스럽게 첫 사이클에서 집어듦. wakeup Event는 워커 자체 초기화 시 생성됨.

## 5. 복원 후 동작 시퀀스

```
부팅 → load_manifest → _queue.append(N items)
     → start_workers → 워커 N개 spawn
                     ↓
                     워커가 _queue.popleft → _active[id]=state
                     phase = "deciding"
                     _persist_queue_locked() (queued→active 전환 반영)
                     ↓
                     decide_capture(data_dir, code, date, force_retry)
                     ├─ COMPLETE → phase="skipped"
                     ├─ SOURCE_PARTIAL (force_retry=false) → phase="skipped"
                     ├─ CLIENT_INCOMPLETE → resume=True → collect_stock_date
                     │                                    (last_time_ms부터 이어감)
                     └─ NONE → resume=False → collect_stock_date (처음부터)
                     ↓
                     _finalize_item → _done.append + _persist_queue_locked
                                      (이제 매니페스트에 빠짐)
```

`paused=true`로 복원되면 워커가 wait에서 깨지 않고 멈춰 있음. UI에서 `POST /queue/resume`을 호출해야 진행.

## 6. 손상·엣지케이스

### 6.1 매니페스트 파일 없음
첫 실행 또는 사용자가 수동 삭제. `load_manifest` returns None → 빈 큐로 시작. 정상 동작.

### 6.2 JSON 파싱 실패 / 스키마 미스매치
quarantine: `.queue.json.corrupt-<ts>-<reason>`으로 rename. WARN 로그. 빈 큐로 시작. 사용자가 디스크에서 디버깅 가능.

### 6.3 Version 미스매치
v1 → v2 마이그레이션 시: load_manifest가 quarantine + None 반환. 향후 명시적 마이그레이션 코드를 추가할 수 있는 hook 자리.

### 6.4 매니페스트에 있던 raw 폴더를 사용자가 수동 삭제
복원 시 큐에 들어감 → `decide_capture` → DiskState.NONE → fresh 캡처. 안전.

### 6.5 매니페스트에는 COMPLETE 상태로 진입할 아이템만 남음
복원 직후 워커가 전부 `skipped`로 처리하고 `_finalize_item` → 매니페스트 빔. 정상.

### 6.6 Cookie expired 상태로 paused=true 저장 후 재시작
복원 시 `_queue_paused=True`. 워커는 wait. 사용자가 `.cookie` 갱신 후 `POST /queue/resume` 호출 — 기존 흐름과 동일.

### 6.7 Today-too-early 가드를 우회한 채 매니페스트에 진입?
`enqueue_items` 라우트는 18:00 KST 전 today_kst 아이템을 거부 ([captures.py:719-728](hoga/api/captures.py#L719-L728)). 매니페스트 복원은 이 가드를 거치지 않음. 하지만 컬렉터 자체가 `TodayTooEarlyRefused`를 raise ([orchestrator.py에서 정의](hoga/collector/orchestrator.py)) → 아이템이 `failed`로 끝남. 데이터 손상 없음.

### 6.8 Write 중 크래시
atomic rename 덕분에 `.queue.json`은 항상 직전 일관된 상태 or 새 일관된 상태 둘 중 하나. 부분 쓰여진 `.queue.json.tmp` 잔존 가능 — 다음 write 시 덮어쓰기로 정리. 부팅 시 명시적 cleanup 불필요.

### 6.9 `cancel_all_on_shutdown` 직후 / `stop_workers` 진행 중
`cancel_all_on_shutdown`은 cancel_token만 시그널 ([captures.py:188-198](hoga/api/captures.py#L188-L198)). `_active`는 그대로 — 매니페스트에 active 아이템들이 그대로 남음. 다음 부팅 시 queued로 복원되어 자동 resume. **의도된 동작.**

## 7. 사용자 가시 동작

- **자동 재개.** 서버를 재시작해도 큐에 있던 아이템이 사라지지 않는다. UI를 다시 열면 큐 목록이 그대로 보이고 워커가 자동으로 처리 중이다.
- **paused 상태도 복원.** Cookie expired로 paused된 채로 재시작하면 paused 상태로 복원된다. 사용자가 cookie를 갱신하고 명시적으로 resume.
- **이어서 캡처.** 진행 중이던 stock-date는 처음부터가 아니라 멈춘 페이지 다음부터 fetch 재개 ([orchestrator.py:253-268](hoga/collector/orchestrator.py#L253-L268)).
- **Done 탭은 비어 있음.** 이전 세션의 완료 아이템은 사라진다 ([§2](#2-non-goals) 참고).

## 8. 테스트 전략

### 8.1 새 파일: `tests/test_api_captures_persistence.py`

매니페스트 I/O 단위 테스트:
- `save_manifest → load_manifest` 라운드트립 (paused, 빈 items, 다수 items, pause_origin 섞임)
- atomic rename: write 도중 `.tmp` 잔존 시뮬레이션 후 다음 write로 정상 복구
- 손상 시나리오: 빈 파일, 비-JSON, 누락 필드, 잘못된 타입 → quarantine + None
- version 미스매치 → quarantine + None
- 파일 없음 → None (예외 없음)

### 8.2 기존 파일 확장: `tests/test_api_captures_queue.py`

매 write hook 지점 검증:
- enqueue 후 `.queue.json` 존재 + items 매치
- queued → active 전환 후 매니페스트 반영
- finalize 후 매니페스트에서 아이템 빠짐
- cancel (queued) 후 매니페스트 반영
- cancel-all 후 매니페스트 비어 있음
- cookie expired 후 paused=true 매니페스트

### 8.3 신규: `tests/test_api_captures_restore.py`

복원 단위 테스트:
- 매니페스트에 3 items, `_restore_queue_from_manifest` 호출 → `_queue`에 3개 (FIFO 순서 보존, phase="queued")
- 매니페스트 paused=true → `_queue_paused=True`로 복원
- 매니페스트 없음 → 큐 빈 채로 함수 무사 반환
- 손상 매니페스트 → quarantine 파일 생성 + 큐 빈 채로 함수 반환

### 8.4 통합: `tests/test_api_captures_restore_integration.py` (asyncio + TestClient)

- 큐에 fake-client 아이템 2개 enqueue → 1개 capturing 상태에서 `stop_workers` + `_restore_queue_from_manifest` + `start_workers` 시뮬레이션 → 워커가 두 아이템 모두 처리 → done이 2개
- raw 페이지가 일부 있는 디렉토리 + 매니페스트에 해당 아이템 → 복원 후 fake-client가 `resume=True`로 호출되는지 검증

### 8.5 Adversarial (manual)

- 실제 캡처 진행 중 `kill -9 <uvicorn-pid>` → 재시작 → UI에서 큐가 살아있고 capturing이 이어지는지
- `data/.queue.json`을 손으로 손상시키고 재시작 → 큐는 비지만 서버는 정상 부팅

## 9. 위험과 완화

| 위험 | 가능성 | 영향 | 완화 |
|---|---|---|---|
| 매 mutation마다 fsync로 hot path 지연 | Low | Low | 매니페스트 <10KB, atomic rename 평균 <1ms. 측정해서 미체감이면 그대로 유지. |
| 사용자가 의도치 않게 자동 재개된 캡처에 놀람 | Low | Low | §9에 자동 재개 동작 문서화. 필요 시 추후 settings 토글 추가 (out-of-scope). |
| Cancel 직전 크래시 → 사용자 의도와 어긋난 재개 | Low | Medium | 받아들이는 트레이드오프. 자동 재개를 명시적으로 선택했고, 사용자는 부팅 후 큐를 보고 cancel 가능. |
| 매니페스트가 raw 디스크 상태와 어긋남 (수동 폴더 삭제) | Low | Low | `decide_capture`가 디스크를 진실의 원천으로 → NONE으로 라우팅. |
| Multi-worker 환경에서 매니페스트 race | Very Low | High | `WEB_CONCURRENCY > 1` 자체가 boot 시 거부됨 ([captures.py:54](hoga/api/captures.py#L54)). 새로운 race 없음. |
| `.queue.json`이 stock-date 폴더 listing에 끼어 보임 | Low | Low | dotfile이라 대부분 도구가 숨김. inventory glob은 stock-date 패턴 매치라 무관. |

## 10. Out of scope, 후속

- **Done 히스토리 영속화** — §11의 capture history view와 함께. SQLite로 풀 가능성.
- **매니페스트 schema migration v1 → v2 코드** — 첫 migration이 필요할 때 추가.
- **Multi-instance 동기화** — 한 머신에서 두 uvicorn 인스턴스가 같은 data_dir을 공유할 일 없음.
- **Settings toggle for auto-resume** — 사용자가 "재시작 시 큐 비우고 시작" 옵션 원하면 추후 추가.
- **Manifest backup rotation** — `.queue.json.corrupt-*` 파일들이 쌓이면 manual cleanup. 자동 정리는 over-engineering.

## 11. 구현 순서 힌트 (Plan에서 정밀화)

1. **`_atomic_write.py` 추출** + symbols.py 마이그레이션 + 회귀 테스트 (ADR-0015 footer가 예고한 추출)
2. `QueueManifest`, `QueueManifestItem` Wire 모델 추가
3. `captures_persistence.py` + 단위 테스트 (save/load/quarantine)
4. `captures._persist_queue_locked()` 헬퍼 + 매 write hook에 호출 삽입 + `reset_state_for_tests` 확장 + 기존 테스트 확장
5. `_restore_queue_from_manifest` + 단위 + 통합 테스트
6. `app.py` lifespan에서 `start_workers` 전에 복원 호출
7. **Frontend SSE disconnect 핸들러 확장**: [frontend/src/api/sse.ts:80-82](frontend/src/api/sse.ts#L80-L82)에 `CAPTURE_QUEUE_QUERY_KEY` + `CALENDAR_QUERY_KEY` invalidate 추가. 단위 테스트로 disconnect → 두 query key가 invalidate되는지 검증.
8. ADR-0019 작성 (위치 비대칭, auto-resume, don't-persist-done 근거)
9. Adversarial 수동 검증 + 문서화

각 단계는 이전 단계 위에 cleanly 빌드 — Plan은 각 단계를 별도 sub-task로 break down하고 TDD 사이클 부여.

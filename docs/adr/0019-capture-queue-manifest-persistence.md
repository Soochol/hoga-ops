# 0019 — Capture Queue 매니페스트는 data_dir 내부에 영속화하고 부팅 시 자동 재개

**Status:** proposed (2026-05-24) — pending implementation of `docs/superpowers/specs/2026-05-24-capture-queue-persistence-design.md`

**Related:**
- ADR-0007 — captures 모듈 단일 유지 + disk_state 추출
- ADR-0015 — Symbol Master 디스크 영속화 (이 ADR의 직접적 선례; 위치 결정에서 의도적으로 분기)
- `docs/superpowers/specs/2026-05-24-capture-queue-persistence-design.md` — 본 ADR이 근거를 보존하는 spec

## Decision

Capture Queue의 active + queued 아이템 상태는 `<data_dir>/.queue.json`에 JSON으로 영속화한다. 매 큐 mutation마다 `_lock` 안에서 동기 atomic write가 발생한다. 서버 부팅 시 lifespan이 `start_workers()`보다 **먼저** 매니페스트를 로드해 큐를 복원하고, 워커가 자동으로 처리를 재개한다.

기록되는 구조적 결정들:

1. **매니페스트 위치는 data_dir 내부 (`<data_dir>/.queue.json`).** ADR-0015의 Symbol Master는 worktree-cross XDG (`~/.local/share/hoga-ops/`)에 있지만 큐는 의도적으로 data_dir scope. 큐 아이템은 (Code, Stock-Date) 짝을 가리키고 그 짝의 raw 페이지(`first_NNN.tsv`)가 data_dir에 있으므로, **매니페스트와 매니페스트가 가리키는 디스크 상태는 같은 디렉토리에 있어야 일관성이 보장됨**. `git clean -fdx` 또는 worktree 삭제 시 큐와 raw 페이지가 함께 사라지는 것이 올바른 동작.

2. **atomic_write_json 공유 헬퍼 추출 (`hoga/api/_atomic_write.py`).** ADR-0015 footer가 명시적으로 예고한 시점 — "If a second persistence target appears... extract the helper into a util module via a new ADR." 큐 매니페스트가 그 두 번째 타깃. symbols.py도 동시 마이그레이션하여 두 호출자가 같은 헬퍼를 공유.

3. **schema_version 필드 사용 (ADR-0015 컨벤션).** 첫 버전은 `1`. 미스매치 발견 시 quarantine + None 반환. 향후 v2 마이그레이션은 별도 ADR로.

4. **JSON, parquet/SQLite 아님.** ADR-0015와 동일 근거: 매니페스트는 *metadata* 카테고리 (alongside `meta.json`, `_progress.json`, `symbol-master.json`), *time-series capture* 카테고리 아님. 30~90개 아이템 × ~120 bytes per item ≈ 10KB 이하. 인메모리 hot path는 dict/deque, 디스크 포맷은 한 번-per-mutation write에만 영향.

5. **자동 재개 (manual resume 버튼 없음).** 부팅 후 워커가 큐를 보고 즉시 처리 시작. 단일 사용자 로컬 도구에서 "재시작하면 큐가 복원된다"는 단순 mental model이 user predictability를 극대화. paused=true 상태로 저장됐을 때만 사용자 명시 resume 필요 (cookie expired 등 의도적 일시정지였으므로 자동 재개하면 안 됨).

6. **Done 리스트는 영속화하지 않음.** 휘발성. 사용자가 `DELETE /done`으로 언제든 비울 수 있는 ephemeral 상태와 일관성 유지. Capture 히스토리 영구 보존은 별개 feature (§11 follow-up).

7. **Write 실패는 흡수.** `save_manifest`가 `OSError`를 catch + WARN 로그 + propagate 안 함. **인메모리 상태가 런타임 진실의 원천**이고 매니페스트는 재시작 복원용 보조 영속화. 디스크 failure가 enqueue/finalize를 막으면 안 됨.

8. **Frontend SSE disconnect 핸들러 확장이 본 ADR의 일부.** [frontend/src/api/sse.ts:80-82](frontend/src/api/sse.ts#L80-L82)의 disconnect 분기에 `CAPTURE_QUEUE_QUERY_KEY` + `CALENDAR_QUERY_KEY` invalidate 추가. 백엔드만 복원하고 프론트엔드가 새로고침 안 하면 user-facing 자동 재개가 깨짐.

## Context

ADR-0007이 기록한 Plan B 큐 시스템(워커 풀 + cookie pause + queue/active/done 상태)은 모든 큐 상태를 `hoga/api/captures.py`의 모듈 싱글톤(`_queue`, `_active`, `_done`, `_queue_paused`)에 보관한다. 단일 uvicorn worker라는 제약 ([hoga/api/captures.py:54](../../hoga/api/captures.py#L54)) 덕분에 인메모리 싱글톤이 충분했지만, **서버 재시작이 모든 큐 상태를 휘발**시킨다.

기존 spec(`2026-05-21-capture-ui-design.md` §9)은 이 제약을 인정하고 "사용자가 수동으로 Resume" 흐름을 의도된 복구 메커니즘으로 문서화했다. 그러나 실제 사용 패턴 — 30~90개 Stock-Date를 한 번에 enqueue하고 수 시간 캡처 — 에서는 재시작 후 수동 재입력 비용이 큼.

캡처된 raw 페이지 자체는 이미 디스크에 안전하게 영속화되어 있고, `decide_capture` ([hoga/api/eligibility.py:69-80](../../hoga/api/eligibility.py#L69-L80))가 `CLIENT_INCOMPLETE → resume=True`로 라우팅하므로 **개별 Stock-Date의 이어서 캡처 메커니즘은 이미 완성**되어 있다. 빠진 건 오로지 "사용자가 무엇을 캡처하려 했는지" 의도(intent) — 즉 큐 목록 자체.

## Alternatives considered

### A. SQLite로 큐 + 히스토리 저장

큐와 done 히스토리를 둘 다 SQLite 테이블에 저장. 트랜잭션, 쿼리, 향후 capture history view(§11) feature 자연스럽게 풀림.

Rejected:

- 본 spec의 요구사항(active + queued 영속화)에 비해 과설계. JSON 매니페스트 ~120 lines vs SQLite 스키마 + migration + DB connection lifecycle ~수백 lines.
- ADR-0015가 정립한 *metadata는 JSON* 카테고리를 깬다. 큐가 time-series 데이터가 아니라 메타데이터에 가까움.
- 새 의존성을 도입한다 (sqlalchemy/aiosqlite). 단일 사용자 로컬 도구에 정당화 어려움.
- capture history view 후속 작업이 진짜 필요할 때 별도 ADR로 SQLite 도입하면 됨 — 그때는 큐도 함께 마이그레이션 가능.

### B. 디스크 스캔만으로 복원

부팅 시 `data/<code>/<date>/_progress.json`을 모두 훑어 incomplete인 것을 큐에 추가. 별도 매니페스트 파일 없음, 진실의 원천 1개.

Rejected:

- **시작도 안 한 큐 아이템 복구 불가.** "큐에 넣었지만 워커가 아직 안 잡은" 아이템은 디스크에 흔적이 없다. 사용자가 90개를 enqueue하고 바로 재시작하면 0개 복원.
- **`force_retry` 플래그 손실.** 사용자가 명시적으로 force_retry로 enqueue한 의도가 디스크에 기록되지 않음.
- **의도치 않은 아이템 끼어듦.** 다른 worktree에서 또는 다른 컨텍스트에서 incomplete 상태로 남은 stock-date를 모두 끌어들이게 됨. 사용자 의도와 어긋남.
- **`paused` 상태 복원 불가.** Cookie expired로 paused 상태로 종료됐는데 부팅 시 paused 정보가 없어 자동 재개되어 즉시 또 만료 — 무한 루프.

### C. Symbol Master 위치(`~/.local/share/`)에 똑같이 저장

ADR-0015가 worktree-cross 글로벌 위치를 선택했으니, 일관성 위해 큐도 동일하게.

Rejected: 두 데이터의 *cardinality와 scope*가 완전히 다르다.

- Symbol Master = "KRX에 어떤 종목이 존재하는가" — 전역, 모든 worktree에서 동일, KRX 데이터.
- Queue = "이 data_dir에서 어떤 (code, date)를 캡처 중인가" — data_dir-local, worktree마다 다름, 사용자 의도.

두 worktree가 같은 매니페스트 파일을 공유하면 한 쪽에서 enqueue한 아이템이 다른 쪽에서 워커에 잡혀 잘못된 data_dir에 raw 페이지가 쌓이는 재앙적 결과. data_dir 내부 위치가 이 종류의 confusion을 구조적으로 차단.

### D. 비동기 background-task로 매니페스트 write

매 mutation 동기 write 대신, dirty flag를 세팅하고 background task가 debounced로 write.

Rejected:

- 매니페스트가 <10KB라 atomic write가 평균 <1ms. 동기 write의 hot-path 영향 무시 가능.
- Background task 도입은 lifespan 관리 + cancellation 책임을 늘림.
- Debounce는 crash window를 넓힌다 — debounce interval 내 mutation이 손실 가능.

### E. Phase 정보를 그대로 매니페스트에 저장

`capturing` / `parsing` 등 상세 phase를 저장해서 복원 시 동일 phase로 시작.

Rejected: 인메모리 phase 상태(`pages_done`, `started_at_ms`, `frontier` 등)를 일관성 있게 다 저장하려면 매니페스트가 비대해진다. 더 중요하게, **이미 디스크에 진실의 원천이 있다** (`_progress.json`, raw 페이지). `phase="queued"`로 시작해서 `_run_item → decide_capture` 경로가 자동으로 resume vs skip vs fresh를 결정하게 두는 것이 single-source-of-truth 원칙에 부합.

## Consequences worth flagging for future readers

- **매니페스트 파일의 권위는 인메모리 < 디스크 raw 페이지.** 매니페스트는 "사용자가 무엇을 캡처하려 했는지"만 기록한다. 실제 캡처 진행 상태는 `_progress.json` + `first_NNN.tsv`가 진실의 원천. 둘 사이 불일치는 `decide_capture`가 해결.

- **자동 재개의 의도치 않은 결과.** 사용자가 "큐 중단하려고" `Ctrl+C`를 눌렀다가 재시작하면 큐가 자동 재개되어 다시 시작됨. 의도적으로 끊으려면 `POST /api/captures/cancel-all`을 먼저 호출해야 매니페스트가 비어 시작 시 빈 큐가 됨. 이 trade-off는 받아들임 — single-user local tool의 predictability 우선.

- **`.queue.json`이 data_dir listing에 보임.** dotfile이라 대부분 도구가 숨김 처리하지만 `ls -la`에는 노출. inventory glob은 stock-date 패턴(`NNNNNN/YYYYMMDD/`) 매치라 무관.

- **Quarantine 파일이 쌓일 수 있음.** `.queue.json.corrupt-<ts>-<reason>` 파일들이 누적되면 사용자가 manual cleanup. 자동 정리는 over-engineering — 디버깅 자료로 보존 가치 있음.

- **`_atomic_write.py`는 third caller가 등장할 때까지 두 호출자(symbols, captures_persistence)만 가짐.** ADR-0007의 "introduce a seam only when something actually varies across it" 원칙 + ADR-0015의 "two-adapters rule"에 따라 *지금이 추출 시점*. 향후 새로운 metadata 영속화(e.g., 사용자 설정 파일)가 등장하면 동일 헬퍼 재사용.

- **Frontend SSE disconnect 확장의 범위.** 본 ADR 작업으로 disconnect 시 `STOCK_DATES_QUERY_KEY` + `CAPTURE_QUEUE_QUERY_KEY` + `CALENDAR_QUERY_KEY` 셋이 invalidate된다. 이는 capture-ui spec §10의 미해결 TODO("we will extend it to also invalidate ['capture', 'latest']")를 의도와 다른 방식으로(latest는 이미 retired됨) 해결.

## When to revisit

- Capture history view (§11 spec follow-up)가 구현될 때 — done 리스트를 영속화할 필요가 생기면 큐 매니페스트도 같은 store(SQLite)로 마이그레이션을 고려.
- 한 데이터 디렉토리를 두 인스턴스가 공유하는 시나리오가 등장 — 매니페스트 race condition + lock file 필요해짐. 현재 single-worker 가정 깨질 때.
- 매니페스트 schema v2 마이그레이션이 필요할 때 — `_load_manifest`에 dispatch 추가하는 별도 ADR.
- `force_retry`나 `pause_origin` 외의 새로운 큐 아이템 필드가 wire 노출되면 — 매니페스트 schema v2 + migration code.

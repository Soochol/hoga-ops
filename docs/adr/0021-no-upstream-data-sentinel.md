# 0021 — Upstream No-Data: sentinel 파일 + DiskState 확장

**Status:** accepted (2026-05-24) — force-gated retry parts superseded by ADR-0081

**Related:**
- ADR-0007 — disk_state 모듈 추출 (단일 분류 책임). 본 ADR이 그 분류기에 새 상태 한 값을 더한다.
- ADR-0009 — UpstreamCode 별도 enum. 본 ADR의 "upstream"은 같은 hogaplay 경로를 가리키지만 분류 축이 다름 — UpstreamCode는 HTTP 4xx/5xx 에러 카테고리, NO_UPSTREAM_DATA는 200 OK + 빈 본문이라는 *정상* 응답의 한 형태.
- ADR-0019 — Capture Queue manifest persistence. `_done` 휘발성 정책이 본 ADR의 "마이그레이션 불필요" 결론을 뒷받침.
- ADR-0020 — DiskState 확장 패턴의 선례 (INVALID 추가). 본 ADR이 동일 패턴을 한 번 더 적용.
- `docs/superpowers/specs/2026-05-24-no-upstream-data-design.md` — 본 ADR이 근거를 보존하는 spec.

## Decision

hogaplay의 `info.php`가 HTTP 200 + 빈 본문을 반환하는 케이스(**Upstream No-Data**)를 **명시적 시스템 상태**로 표현한다. 다음을 묶어서 한 ADR로 기록한다:

1. **Sentinel 파일 (`raw/{date}/{code}/.no_upstream_data`)**이 영구성 메커니즘. 빈 파일, 존재 자체가 시그널. 같은 디렉토리의 0바이트 `info.tsv`/`chart.tsv`/`_progress.json`은 sentinel 작성 시 함께 삭제 — invariant: sentinel은 단독 존재.
2. **`DiskState.NO_UPSTREAM_DATA` 추가**. `check_disk_state`의 분기 우선순위는 sentinel-first — `parquet/meta.json` 검사보다 먼저 sentinel 존재를 확인. ADR-0020의 `INVALID` 추가 패턴과 동일한 형태의 확장.
3. **`SkipReason = "no_upstream_data"` 추가**. 워커는 `UpstreamNoDataError`를 잡아 `phase="skipped"`로 종료 — `failed` 분류 아님. 운영 시그널 의미상 "데이터 없음"은 실패가 아니고 "할 일이 애초에 없었음".
4. **`force_retry=True`가 sentinel을 우회**. `decide_capture`는 NO_UPSTREAM_DATA + force_retry=True일 때 sentinel을 삭제하고 fresh capture로 진행. 기존 `SOURCE_PARTIAL` 우회 정책과 동일한 모양.
5. **CalendarStatus 한 값 추가 + 새 마커 `–`**. ADR-0004 미러 디시플린에 따라 frontend `CalendarStatus` 타입에도 동일 값 추가. 마커는 `✕ broken` (client_incomplete) 과 명확히 시각 구분.
6. **자동 마이그레이션 없음**. 003490/20260319 한 케이스라 `force_retry`로 사용자가 직접 정리. 미래에 동일 패턴이 다수 발견되면 일회성 스크립트 `tools/migrate_zero_byte_info_to_sentinel.py`를 작성할 수 있음.

## Context

2026-05-24, `(003490, 20260319)` Stock-Date capture가 `internal_error: info row expects >=22 fields, got 0`으로 실패. 디스크 검사 결과 `raw/20260319/003490/info.tsv`와 `chart.tsv`가 모두 0바이트. 사용자가 hogaplay 사이트를 직접 확인한 결과 — **해당 일자에 그 종목 데이터가 애초에 존재하지 않음**.

근본 원인은 hogaplay의 외부 contract: 데이터가 없는 (code, date) 조합에 대해 HTTP 404나 4xx를 반환하지 않고 **HTTP 200 + 빈 본문**을 반환. 우리 콜렉터는 2xx 응답이면 본문을 그대로 `info.tsv`에 쓰고 진행 — 파서가 나중에 빈 파일을 읽으려다 폭발. UI는 이를 `internal_error`로 분류해 사용자에게 "시스템 버그처럼" 보임.

이는 분류 오류다: "upstream에 데이터 없음"은 정당한 외부 상태이지 우리 시스템의 결함이 아님. 시스템이 이 상태를 (a) 콜렉터 경계에서 감지하고 (b) 영구적으로 표시하고 (c) UI에서 별도 시그널로 surface해야 한다.

## Alternatives considered

### A. meta.json에 `no_upstream_data: true` 플래그

`parquet/{date}/{code}/meta.json`에 일반 메타와 함께 플래그 작성, `classify_from_meta`에 분기 추가. ADR-0020의 invariant 카탈로그 + classify_from_meta 패턴과 동일 매커니즘.

**기각 이유**: meta.json 작성에는 의미있는 데이터(trades, snapshots 등)가 전제. NO_UPSTREAM_DATA는 그 데이터가 *없는* 상태라 빈 parquet 파일 + skeleton meta.json을 생성해야 함 — 의미적으로 어색하고 disk 낭비. `_build_meta`도 분기 처리 필요. ADR-0020의 archival 패턴은 "수집된 데이터에 대한 평가"가 본질이고, 우리는 "수집할 데이터가 없음"이라 카테고리가 다름.

### B. 중앙 ledger (`data/no_upstream_data_ledger.json`)

모든 (code, date) 조합을 하나의 JSON에 기록. 빠른 조회.

**기각 이유**: ADR-0019의 atomic write + manifest 패턴을 추가로 도입해야 함 (또는 ADR-0019의 헬퍼 재사용). 무엇보다 `disk_state` 분류 입력이 `raw_dir`/`parquet_dir` 디스크 상태에서 단일 ledger로 옮겨가면 ADR-0007의 single-source-of-truth 원칙이 깨짐. 한 (code, date)의 상태가 두 곳에 분산되는 안티패턴. 동시성 처리 비용도 추가.

### C. `failed` phase + `error.code="no_upstream_data"`

워커가 `UpstreamNoDataError`를 잡아 `failed`로 분류. CaptureErrorCode에 새 enum 값 추가.

**기각 이유**: 운영 시그널 의미가 왜곡됨. `total_failed`는 사람이 봐야 하는 알람 신호 — 그 안에 "정상이지만 데이터 없음" 케이스가 섞이면 알람 노이즈가 됨. SkipReason은 이미 "정상 진행 중 건너뜀" 의미를 가진 분류이며, `already_complete` / `source_partial`처럼 새 값 하나 추가하는 게 최소 변경.

### D. 새 phase `no_data` 추가

`CapturePhase` enum을 9개로 확장.

**기각 이유**: phase enum은 워커 lifecycle을 표현 — 모든 phase-handling 코드(captures.py worker, phase.ts, `is_terminal` predicate, manifest persistence, drained event, UI 마커 매핑)에 새 분기 강제. ADR-0006의 "captures.py 단일 모듈" 정책과 코드 변경 표면적을 비교하면 SkipReason 확장의 ~10배 변경. YAGNI 위반.

## Consequences

- **`disk_state.py`의 입력 모델이 한 단계 깊어짐.** sentinel 파일을 검사하는 분기가 `check_disk_state`의 첫 번째 단계로 들어가고, parquet/raw 검사보다 우선순위가 높음. ADR-0007의 single-classifier 책임은 유지 — 모든 호출자(eligibility, calendar, queries)가 자동으로 새 상태 인식.

- **`force_retry`의 의미가 누적적으로 명확해짐.** 이제 `force_retry`는 "현재 디스크 상태가 무엇이든 fresh capture를 시작" 의미. SOURCE_PARTIAL + NO_UPSTREAM_DATA 둘 다 우회. 사용자 mental model: "force_retry는 모든 cache를 무시한다."

- **운영 시그널의 분리가 명시적이 됨.** `total_failed`는 진짜 실패(콜렉터 크래시, parser 결함, 네트워크 5xx), `total_skipped`는 "할 일 없음"(완료/부분/upstream 부재). 이 둘이 섞이지 않는 게 본 ADR의 운영적 가치.

- **`_done` 휘발성과의 정합.** ADR-0019에 따라 `_done` 항목은 매니페스트에 영속화 안 됨. 서버 재시작 후 `skipped/no_upstream_data` 행은 사라지지만 디스크 sentinel은 남아 있어서, 사용자가 같은 (code, date)를 다시 enqueue하면 `decide_capture`가 sentinel 보고 즉시 `skipped/no_upstream_data` 반환 — 캡처 동작이 idempotent. 매니페스트와 디스크 상태의 책임 분리가 자연스럽게 작동.

- **마이그레이션 비용 없음.** 003490/20260319 단일 케이스라 사용자가 `force_retry`로 enqueue → 새 코드 경로가 자동으로 sentinel 작성 + `_done`의 옛 `failed` 행 dismiss. 일회성 스크립트는 다수 케이스 발견 시 추가.

- **외부 contract 가정 하나가 spec에 박힘.** 본 ADR은 "hogaplay가 빈 본문을 데이터-없음 시그널 *로만* 사용한다"를 전제. 만약 transient 에러(rate limit, auth 일시 실패)에서도 hogaplay가 200 + 빈 본문을 돌려준다면 legitimate failure가 silently sentinel될 위험. 완화책은 `force_retry`(사용자 재시도)와 모니터링: NO_UPSTREAM_DATA 셀이 비정상적으로 늘면 외부 contract 재검토.

## Why an ADR

본 결정은 ADR-FORMAT의 세 기준을 모두 충족:

1. **Hard to reverse** — sentinel 파일 포맷이 디스크에 박힘. 변경 시 마이그레이션 스크립트 + 사용자 데이터 변환 필요.
2. **Surprising without context** — 미래 reader가 "왜 빈 응답을 별도 상태로 처리했지? 단순히 retry하면 안 됐나?" 의문 가질 가능성. 본 ADR이 (a) hogaplay 외부 contract, (b) failed/skipped 운영 시그널 의미 분리, (c) sentinel-first 분류 순서의 근거를 보존.
3. **Real trade-off** — 4개 대안(meta.json flag / ledger / failed / new phase) 모두 검토 + 기각 사유 기록. sentinel + skipped는 ADR-0007/ADR-0020의 single-classifier 원칙과 ADR-0006의 minimal-change 원칙이 교차하는 지점에서 자연스럽게 도출됨.

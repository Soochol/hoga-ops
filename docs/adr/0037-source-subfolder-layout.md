# 0037 — Source별 서브폴더로 captures 트리 확장

**Status:** accepted (2026-05-27)

**Related:**
- ADR-0006 — `hoga/api/captures.py`는 단일 모듈 유지 (성장 예산 발동 조항)
- ADR-0007 — capture grows, disk_state extracted
- ADR-0021 — `.no_upstream_data` sentinel (per-Stock-Date 마커)
- `docs/superpowers/specs/2026-05-27-live-capture-design.md`

## Decision

같은 **Stock-Date**에 둘 이상의 **Source**(`hogaplay`, `kis_live`)가 공존할 수 있게 되면서, captures 디스크 트리에 **source 레벨 디렉토리**를 추가한다:

```
<data_dir>/raw/{date}/{code}/{source}/orderbook.parquet
                              {source}/trades.parquet
                              {source}/brokers.parquet
                              {source}/meta.json
```

기존 단일 source 가정의 경로 `<data_dir>/raw/{date}/{code}/orderbook.parquet`는 **마이그레이션**된다 — 기존 데이터는 `{source=hogaplay}` 서브디렉토리로 이동.

`.no_upstream_data` sentinel(ADR-0021)도 source별로 분리된다 — `<data_dir>/raw/{date}/{code}/{source}/.no_upstream_data`. 한 source에 데이터가 없다는 사실이 다른 source의 가용성을 부정하지 않기 때문.

## Why

세 가지 대안을 검토했다.

**A. 파일명 prefix** (`raw/{date}/{code}/orderbook.hogaplay.parquet`)
거부 사유:
- 전 코드베이스가 `orderbook.parquet`라는 고정 파일명을 `Table.load(...)` / `disk_state.classify_from_meta` / Inventory의 size_bytes 합산 / Invariant 카탈로그 등 여러 곳에서 가정. glob 패턴으로 변경해야 하는데 그 변경 범위가 source 서브폴더 도입보다 크다.
- 메타 파일(`meta.json`, `progress.json`, `.no_upstream_data`)에도 동일한 prefix를 강제해야 한다 — sentinel/marker가 여러 source에 따라 분기되는 게 디렉토리 분리보다 추론하기 어렵다.
- 사용자가 디렉토리를 열어 봤을 때 한눈에 어떤 source가 있는지 보이지 않는다.

**B. 최상위 디렉토리 분리** (`<data_dir>/raw_hogaplay/...` vs `<data_dir>/raw_kis_live/...`)
거부 사유:
- Stock-Date의 두 source artifact가 물리적으로 멀어져 cross-source 정합성 검사(같은 Stock-Date에 두 source가 다 있는지, 둘 다 COMPLETE인지)가 두 트리를 동시에 walk해야 한다.
- `<data_dir>` 환경변수 / `data_dir` 인자 / 백업 정책 모두 두 트리를 인지하도록 수정 필요. 사실상의 새 partition.
- 추후 세 번째 source(e.g., KIS WebSocket)가 추가될 때 또 새 최상위 디렉토리.

**C. source별 서브폴더** ← 채택
근거:
- Stock-Date 단위 동시 비교가 single-directory listing으로 가능 — disk_state가 한 디렉토리 walk로 cross-source 판정 수행.
- 기존 `<data_dir>/raw/...` 경로의 상위 두 레벨(`{date}/{code}`)이 그대로 유지되므로 일부 path-aware 코드(예: backup script, inventory walk)의 변경량이 작다.
- 새 source 추가 시 서브폴더 한 개만 만들면 됨. 확장성 좋음.

## Impact

### 변경되는 disk-state 시그너처

기존 `DiskState`는 한 Stock-Date 전체 상태를 표현했지만, 이제 source별 상태가 가능하다. plan 단계에서 다음 중 선택:
- per-source DiskState + aggregate 함수 (`worst_state(states_per_source)`) — frontend의 `STATE_SEVERITY` SSOT 패턴과 일관
- DiskState 자체에 source-aware 변형 추가 (`HOGAPLAY_COMPLETE_KIS_PARTIAL` 등) — combinatorial explosion 위험

본 ADR은 layout만 결정하고, DiskState 모델 변경은 plan에서 결정.

### 마이그레이션

기존 `<data_dir>/raw/{date}/{code}/*.parquet`가 존재하면:
- 자동 일회 마이그레이션 스크립트로 `hogaplay/` 서브디렉토리로 이동.
- 마이그레이션 끝난 표시는 `<data_dir>/.layout_v2` sentinel.
- 마이그레이션 미완 상태에서 새 코드 실행시 일시 정지 → 자동 마이그레이션 → 재개.

상세 마이그레이션 절차는 plan.

### sentinel 분리

`.no_upstream_data`는 hogaplay 컨텍스트(ADR-0021)에서 도입된 sentinel. kis_live는 동일 컨셉이 다르게 발현 (KIS API는 정규 응답으로 "no data" 반환 가능 vs hogaplay의 empty body) — source별 sentinel로 분리하면 두 sentinel이 의미가 같더라도 origin이 다른 신호로 격리된다.

### Invariant 카탈로그 영향

ADR-0020의 invariant `check` 함수는 meta dict를 받아서 위반 여부 반환. 이제 meta가 source-aware (어느 source의 meta인지)이므로 일부 invariant는 source-conditional이 될 수 있다 (예: hogaplay에서만 의미 있는 `global_seq` 단조 증가는 kis_live meta에 적용 안 됨). plan 단계에서 invariant 카탈로그 audit.

## Invariant introduced

> `<data_dir>/raw/{date}/{code}/` 직속 자식은 source 디렉토리뿐이다. parquet/json 파일이 직속에 놓이지 않는다.

위반 시: legacy 경로 코드와 새 코드가 둘 다 valid한 데이터를 만든다고 착각해서 둘 다 읽는 race가 발생.

## ADR-0006 성장 예산 발동 노트

ADR-0006의 "Growth budget" 조항이 명시한 트리거 ("a second capture source besides hogaplay, which would create a real two-adapters scenario at the `client_factory` boundary")가 발동되었다. 그러나 captures.py는 본 ADR로 인해 split되지 않는다 — 두 번째 source는 별도 모듈 (`hoga/live/*`)에 산다. 즉 ADR-0006의 single-module 결정은 hogaplay 진영에서만 유지되고, kis_live는 처음부터 별도 모듈에서 시작한다. 두 모듈은 disk artifact의 공유 layout (본 ADR)으로만 만난다.

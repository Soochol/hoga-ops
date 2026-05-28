# 0038 — Live Capture는 JSONL append + 18:00 Promotion (직접 Parquet 쓰기 거부)

**Status:** accepted (2026-05-27), amended by ADR-0043 (2026-05-28)

**Related:**
- ADR-0019 — Capture Queue manifest persistence (재시작 안전성 일반 패턴)
- ADR-0034 — Scheduler as queue client (Daily Scheduler 책임 분리)
- ADR-0037 — Source별 서브폴더 layout
- **ADR-0043 — Today Promotion: 장 중 N분 주기 jsonl→Parquet overwrite (본 ADR의 "Future signal to revisit" 트리거 발동 — promote 시점 부분만 amend, hot-path invariant는 유지)**
- `docs/superpowers/specs/2026-05-27-live-capture-design.md`
- `docs/superpowers/specs/2026-05-28-kis-hoga-indicator-always-visible-design.md`

## Decision

Live Capture의 hot path(장 중 09:00~16:00 KST)는 KIS Open API에서 받은 호가/체결/거래원 데이터를 **JSONL append-only**로 `<data_dir>/live/{date}/{code}.jsonl`에 기록한다. **Parquet은 절대 hot path에서 쓰지 않는다**. 장이 끝난 후 18:00 KST Daily Scheduler의 첫 단계 **Promotion**이 JSONL을 Parquet으로 변환한다.

Promotion은 **deferred and batched**:
- 17:30~17:59 사이에 시작하지 않는다 — Live Session(09:00~16:00) 종료 후 안정화 시간을 가진다.
- 18:00에 모든 watchlist 종목의 unpromoted JSONL을 한 번에 처리.
- 멱등 — `kis_live/meta.json` 존재 시 해당 (date, code)는 skip.

## Why

세 가지 대안을 검토했다.

**A. Hot path에서 직접 Parquet 쓰기 (10s마다 또는 1m마다 flush)**
거부 사유:
- Parquet은 row group 단위로 한 번에 쓰는 columnar 포맷. 잦은 append는 작은 row group을 양산해 읽기 효율을 떨어뜨림.
- 10s마다 새 Parquet 파일을 만들면 하루 ~2160개 파일 × 종목 수 × 3 데이터 종 → 30종목 기준 ~200k 파일. 파일시스템 부담 + 다음 read 시 scan 비용.
- 1m마다 flush로 완화해도 ~360개 파일/종목/일. 그리고 마지막 flush 이후 ~1분 데이터는 crash 시 손실.
- "장 중 read 즉시 가능"이라는 장점은 본 spec의 실제 요구사항(`/live` 페이지는 SSE/in-memory 버퍼로 본다, `/replay`는 다음 날 본다)과 맞지 않음.

**B. SQLite (WAL 모드)에 실시간 INSERT**
거부 사유:
- 한 디렉토리에 두 가지 영구 저장 백엔드(Parquet + SQLite) 공존 — Inventory 페이지, backup, disk_state, invariant catalog 모두 두 백엔드를 인지하도록 수정.
- `/api/range` read path는 결국 Parquet 가정 — SQLite를 Parquet으로 변환하는 단계가 어차피 필요 (= Promotion).
- 쓰기 성능 우위는 있지만 본 spec의 부하(30종목 × 10s tick = 3 INSERTs/s)는 JSONL append로도 충분.
- 단일 사용자 로컬 도구에서 트랜잭션 보장은 과잉.

**C. JSONL append + 18:00 Promotion** ← 채택
근거:
- **Crash-safe**: 줄 단위 append → fsync 1회 / cycle. 크래시 시 마지막 줄 1개만 손실(부분 줄 발생) — Promotion 시 마지막 partial line 한 줄을 무시하면 됨.
- **Pattern reuse**: 기존 hogaplay 캡쳐도 "raw 페이지 누적 → 파싱해 Parquet"의 2-stage. 본 결정은 같은 패턴을 새 source에 적용한 것 (raw-equivalent = JSONL).
- **Schema flexibility**: JSONL은 schema 변경에 관대. KIS API 응답 필드가 늘어나거나 추가 메타 데이터를 함께 기록하고 싶을 때 Parquet 스키마 마이그레이션 없이 끝까지 적은 후 Promotion에서 일관된 schema로 정규화.
- **Read 경로 통일**: Promoted Parquet은 기존 `/api/range` read 경로에 그대로 합류. `/live` 페이지의 라이브 차트는 별도 in-memory + SSE이므로 disk read 의존성 없음 (16:00 직후 `/replay`에서 오늘 날짜를 못 보는 2시간 윈도우가 발생하지만, 그 시간엔 `/live`로 보면 됨).

## Trade-off accepted

- 16:00~18:00 사이 `/replay`에서 오늘 날짜 조회 불가. 의도된 동작 — 그 시간엔 `/live`에서 본다.
- 18:00 promote가 실패하면 그날 데이터가 Parquet에 들어오지 않음. JSONL은 그대로 남아있으므로 수동 재실행으로 복구 가능. 자동 retry는 다음 18:00 사이클에 멱등 가드로 자연스럽게 발생.

## Why not stream-to-Parquet via PyArrow ParquetWriter?

PyArrow의 `ParquetWriter`는 같은 파일에 row group을 점진적으로 추가할 수 있다. 이게 hot path에서 직접 Parquet 쓰기의 약점을 일부 보완한다. 그럼에도 거부:

- ParquetWriter는 close()되어야 footer/index가 기록됨. 장 중 crash 시 file footer 미작성 → 파일 자체가 unreadable. 복구 비용이 JSONL의 "마지막 줄 무시"보다 훨씬 높다.
- ParquetWriter open 상태에서 같은 파일을 다른 프로세스가 read 시도하면 안전성 보장 안 됨. `/replay`의 read 경로가 장 중에도 동작하려면 별도 lock 메커니즘 필요.
- 결국 "장 중 read"라는 요구는 disk가 아니라 in-memory buffer + SSE로 만족시키는 게 본질적으로 옳다 — Parquet hot write의 motivation 자체가 사라짐.

## Invariant introduced

> Live Capture hot path는 Parquet writer를 import하지 않는다. `hoga/live/writer.py`의 import에 `pyarrow.parquet` / `polars`가 등장하면 ADR-0038 위반.

위반 시: hot path에서 Parquet 직접 쓰기가 부활하면 본 ADR의 거부 사유들이 다시 살아남.

## Future signal to revisit

- Live Capture가 30종목을 넘어 100+종목으로 확대되고, JSONL append latency 자체가 cycle_lag_ms의 주요 원인이 될 때 (현재 예상 부하에서는 무시 가능).
- `/replay`에서 "오늘 날짜를 16:00~18:00 사이에 봐야 한다"는 요구가 정당화될 때 — 그 경우 Promotion 시점을 앞당기거나 hot streaming 옵션 도입.
- 마지막 partial line 손실이 사용자 시그널로 보고되는 incident가 발생할 때.

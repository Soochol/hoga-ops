# 0115 — KIS live/REST 완결성 판정 + 캡처 파이프라인의 per-source hogaplay 게이트

**Status:** accepted (2026-07-16)

## Context

capture 달력의 ✓(COMPLETE) 판정은 `classify_from_meta`(`hoga/api/disk_state.py`)가
Stock-Date meta.json 의 `collection_complete`/`is_partial` 를 읽어 결정하고,
소스별 상태를 `aggregate_disk_state`("한 소스라도 COMPLETE 면 승격")로 합친다.

그런데 KIS WS/REST 승격기 `_build_meta`(`hoga/live/promote.py`)는 이 두 필드를 **쓰지
않았다**. 결과적으로 `classify_from_meta` 는 kis_live/kis_api 를 항상 CLIENT_INCOMPLETE
로 떨궜고, WS 로 온전히 수집한 날도 달력에 영구 ✕ 로 남았다. 즉 완결성 판정 로직은
hogaplay 파서에만 이식돼 있었다.

동시에, kis_live 를 그냥 COMPLETE 로 승격 가능하게 만들면 `aggregate`("single COMPLETE
source wins")를 소비하는 캡처 파이프라인이 오작동한다: hogaplay 워커가 kis_live-only
COMPLETE 날짜를 `already_complete` 로 스킵하고(더 낮은 화질의 합성 데이터를 영구히
받아들여), catch-up floor 가 전진하고, fail_streak 이 잘못 리셋된다.

**Related:**
- ADR-0037 — 소스별 서브디렉토리(`parquet/{date}/{code}/{source}/`) + 크로스소스 aggregate
- ADR-0075 — `raw/` 는 hogaplay 전용 아티팩트(prune 이 per-source hogaplay 로 게이트)
- ADR-0020/0021 — meta → DiskState 매핑, 센티넬 우선순위

## Decision

**1. kis_live/kis_api meta 에 hogaplay 와 동일한 갭 분석을 붙인다.**
`_build_meta` 가 `analyze_gaps` 로 `collection_complete`/`is_partial`/`gap_ranges` 를
계산한다 — hogaplay 파서와 **같은 함수**. `classify_from_meta` 는 소스 무관하게 이미
동일하므로, 이제 세 소스 모두 같은 COMPLETE/SOURCE_PARTIAL/CLIENT_INCOMPLETE 로직을 탄다.

- `analyze_gaps(..., anchor_edges=True)` 를 라이브 경로에서만 켠다. 기본 False 는 hogaplay
  파서·invariants·`has_meaningful_gaps` 의 기존 연속쌍 분석을 그대로 보존한다. 라이브는
  세션 경계(open→첫 스냅샷, 마지막 스냅샷→auction start)를 가상 앵커로 검사한다: 13:00
  에 시작(서버 지각 기동)하거나 11:00 에 죽은(중도 사망) 스트림은 내부 갭이 없어도 명백히
  부분이며, edge 앵커만이 이를 잡는다.
- `collection_complete` 는 라이브에 `_progress.json` 커서가 없으므로 **시간 기반**으로
  판정한다(`_collection_finished`): 과거일=True, 오늘=15:35 KST(장 마감 15:30 + 5분 버퍼)
  이후만 True. 장중 사이클은 False → CLIENT_INCOMPLETE 유지 → 조기 COMPLETE flip 으로
  당일 hogaplay 캡처를 차단하는 사고를 막는다.
- `promote_one` 의 멱등 스킵은 `collection_complete is True` 일 때만 성립하게 강화한다.
  서버가 장중 사망한 날(마지막 intraday meta=False)을 다음날 배치가 최종화할 수 있다.

**2. aggregate 는 "표시용", 캡처 게이트는 "hogaplay per-source" 로 분리한다.**
`check_disk_state(..., source="hogaplay")` 파라미터를 추가하고, hogaplay 캡처 파이프라인의
4개 소비처를 이 게이트로 전환한다:

| 소비처 | 효과 |
|---|---|
| `eligibility.decide_capture` | kis_live-only COMPLETE 날짜도 hogaplay 캡처 진행 |
| `captures._finalize` done_complete | hogaplay 부분 실패를 kis_live 가 마스킹하지 않음 |
| coverage preview `_classify` | kis_live-only 날짜를 bulk 수집 대상에 유지 |
| `latest_complete_date` | catch-up floor·Watchlist 마커가 kis_live 로 전진하지 않음 |

`source` 제한 결과가 비면 기존 폴백(센티넬 → 레거시 flat meta → raw first_*.tsv → NONE)으로
진행한다 — 이 폴백들은 모두 hogaplay 전용 아티팩트(ADR-0075)라 게이트 의미가 유지된다.
prune(이미 per-source hogaplay), resolve_source(정책 순서만), inventory queries(kis_live
명시 배제), screener(COMPLETE 소비 없음)는 무해로 확인됐다.

**3. 달력은 소스를 구분해 표시한다.**
`_cell_status_for` 는 먼저 hogaplay per-source 상태를 보고, 그것이 NONE 일 때만 KIS
aggregate 를 본다. hogaplay 아티팩트가 아예 없고 KIS 만 있으면 신규 status
`complete_live`/`partial_live`(프론트에서 `--accent` = kis_live 소스 색)로 표시한다.
이로써 (a) "✓ 인데 수집 대상" 모순이 사라지고, (b) 현재 aggregate 가 WS-only 날짜를
hogaplay 문구의 ✕("resume on capture")로 오표시하던 노이즈가 함께 해소된다. 종목 배지
카운트(`symbols`)도 같은 축으로 hogaplay per-source 로 전환한다.

**4. 과거 승격분은 CLI 로 소급한다.**
`hoga backfill-live-meta`(`hoga/live/meta_backfill.py`)가 완결성 필드가 없는 과거
kis_live/kis_api meta 를 `snapshots.parquet` 의 ts_ms 로 재계산해 채운다. 멱등,
과거 날짜만(오늘은 Today Promoter 소관).

## Consequences

- WS 로 온전히 수집한 과거 날짜가 달력에 `complete_live`(✓ accent)로 정직하게 뜬다.
- hogaplay 수집 기회는 보존된다 — 저화질 kis_live 가 고화질 hogaplay 캡처를 대체하지 않는다.
- 세션 경계는 09:00/15:30 하드코딩(반일장 미대응) — 기존 promote 한계와 동일, 이번 범위 밖.
- kis_api 는 폴링 주기가 60s 를 넘는 구간이 있으면 정직하게 ⚠(partial_live)가 된다 —
  영구 ✕ 보다 개선이므로 허용.

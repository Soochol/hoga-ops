# ADR-0126 — 완결성 판정 2축 정착: anchor_edges 통일 + 갭 위치 기반 upstream_gap 사전 판별

- 상태: Accepted (2026-07-23)
- 관련: ADR-0093(identical-count 기반 upstream-gap 확정), ADR-0115(kis_live
  완결성 판정+캡처 게이트), ADR-0124(완결성 우선 소스 정책), ADR-0063(open_ms=0
  정규화), ADR-0007(disk_state = 완결성 판정 SSOT), ADR-0021(NO_UPSTREAM_DATA)

## 맥락

ADR-0124의 완결성 우선(`completeness_first`)은 `classify_from_meta`의
`Classification.state`를 신뢰해 "더 완결한 소스"를 고른다. 그런데 그 등급을 만드는
`is_partial`이 **소스마다 다른 엄격도**로 계산되고 있었다.

`analyze_gaps`에는 `anchor_edges` 파라미터가 있다:

- `anchor_edges=False`: 존재하는 스냅샷들 **사이**의 ≥1분 갭만 본다. 첫 데이터
  이전(leading)·마지막 데이터 이후(trailing)의 공백은 세지 않는다.
- `anchor_edges=True`: 세션 엣지 앵커(09:00 open, ~15:20 auction start)를 기준에
  더해, 늦게 시작했거나 중도 종료된 스트림을 잡는다.

**실시간 promote**(`_completeness_fields`, kis_live/kiwoom_live)는
`anchor_edges=True`로 호출한다. 그런데 **hogaplay 파서**는 인자 없이(= 기본
`False`) 호출했다. promote.py의 주석은 "hogaplay 파서가 돌리는 것과 **동일한** gap
분석"이라 적혀 있었으나 사실이 아니었다 — `False`는 누락된 인자다.

### 실측 증거 (316140, 2026-07-22)

| 소스 | 실제 스냅샷 커버리지 | 기존 판정 | 진실 |
|------|---------------------|-----------|------|
| hogaplay | 14:43~15:30 (장중 47분, ~86% 소실) | `COMPLETE` | 09:00~14:43 선행 공백 |
| kiwoom_live | 09:00~15:30 (전 구간) | `SOURCE_PARTIAL` | 12:28~12:35 interior 갭 1개 |

hogaplay가 다음날 아침 수집돼 업스트림 보유(~18h) 한계로 오전을 영구 소실한
날이다. `anchor_edges=False`라 선행 공백이 안 보여 `COMPLETE`로 오판됐고,
완결성 우선이 **86% 소실된 hogaplay를 "가장 완결"이라며 선택**했다.

### 두 축은 이미 있었다

문제는 새 상태가 없어서가 아니다. `Classification`은 이미 두 축을 분리한다:

- **완결성 축** = `state` (COMPLETE / SOURCE_PARTIAL / …)
- **재수집-액션 축** = `upstream_gap_confirmed` — "다시 받아도 안 고쳐지나" (ADR-0093).
  유일 소비자는 `decide_capture`이고, True면 `upstream_gap`으로 skip한다.

두 축의 **값이 틀렸을** 뿐이다:

1. 완결성 축이 hogaplay에서 거짓(anchor_edges=False).
2. 재수집 축이 `identical_capture_count >= 2`(같은 결과를 2회 재현)에만 근거해
   사실상 죽어 있었다 — hogaplay 18h 소실은 **사전에** 재수집 무의미임을 알 수
   있는데도 두 번 낭비해야 인정됐고, 애초에 완결성 축이 `COMPLETE`라 이 판정에
   **진입조차 못 했다**.

## 결정

새 `DiskState` enum 값을 추가하지 않는다(_AGGREGATE_PRIORITY·completeness_rank·
calendar 매핑·프론트 유니온의 exhaustive 결속 전파 회피). 두 축을 **올바른 값으로
채우고**, 각 소비자가 자기 축만 읽도록 정착한다.

### 결정 1 — hogaplay 파서 anchor_edges 통일 (완결성 축)

hogaplay 파서도 `analyze_gaps(..., anchor_edges=True)`로 호출한다. promote와 판정
기준이 실제로 통일된다. 316140/7-22 hogaplay는 `gap_ranges=[09:00~14:43]`,
`is_partial=true` → `SOURCE_PARTIAL`이 된다.

### 결정 2 — 갭 위치 기반 upstream_gap 사전 판별 (재수집 축)

**갭의 위치가 재수집 가능성의 프록시다.** hogaplay 업스트림은 ~18h만 보유하고
시간이 갈수록 단조적으로 더 잃는다. 세션 경계에 닿는 갭은 재수집으로 복구 불가:

- **leading gap** (`start` ≤ session open): 수집 시점에 업스트림이 이미 앞부분을
  버림. 재수집하면 더 버려진다.
- **trailing gap** (`end` ≥ session close − auction window): 스트림 종료 후. 지난
  시각은 되찾을 수 없다.
- **interior gap** (그 사이): 일시적 수집 실패일 수 있어 재시도 가치가 남는다.

판정 규칙:

- leading/trailing 갭이 있으면 → **즉시** `upstream_gap_confirmed = True`
  (identical-count 불요).
- interior-only 갭은 → 기존 ADR-0093의 `identical_capture_count >= 2` 규칙 유지.

**소스 무관 적용.** `classify_from_meta`에 source 인자를 넘기지 않는다. 근거:
`upstream_gap_confirmed`의 유일 소비자 `decide_capture`는 `source="hogaplay"`
한정 조회라 실질 영향이 hogaplay에 국한되고, 세션 경계 밖 시각은 어느 소스든 사후
복구 불가라는 논거가 소스 무관하게 성립한다. 이 판정은 `gap_ranges` +
`session_open/close_ms`만으로 계산하므로 수집 시각(mtime/promoted_at) 정보가
불필요하다 — hogaplay meta엔 없다.

### 결정 3 — latest_complete_date를 terminal floor로 확장

`latest_complete_date`는 `state==COMPLETE`만 catch-up floor로 삼는다. hogaplay가
`SOURCE_PARTIAL`로 내려가면 floor가 하강해, 개선 불가능한 과거일을 catch-up이
계속 재방문한다(재수집은 `upstream_gap`으로 skip되지만 순회 비용은 남는다).

floor 기준을 **terminal 상태** = `COMPLETE` 또는 `SOURCE_PARTIAL +
upstream_gap_confirmed`로 확장한다. "더 개선 불가능한 날"을 floor로 삼는 게 의미상
옳다.

### 결정 4 — stale meta는 재캡처 아닌 backfill로 재파생

기존 hogaplay `COMPLETE` meta는 `compute_gap_ranges`가 meta 값을 그대로 신뢰하므로
stale로 남는다. 일괄 재캡처는 재수집 폭주를 유발하므로, `backfill_live_meta` CLI를
hogaplay로 확장해 **디스크의 snapshots.parquet에서 anchor_edges=True로 재파생**한다.
`is_partial`/`gap_ranges`만 갱신하고 나머지 필드는 보존하며, 재계산 결과가 저장값과
다를 때만 rewrite(멱등)한다.

## 결과

- 완결성 우선이 316140/7-22에서 kiwoom_live(전 구간)를 올바르게 선택한다.
- hogaplay가 `SOURCE_PARTIAL`로 정직하게 내려가되, edge-gap이 즉시
  `upstream_gap_confirmed`를 채워 `decide_capture`가 자동으로 재수집을 skip한다 —
  추가 배선 없이 폭주가 완충된다.
- promote.py의 "SAME 분석" 주석이 사실이 된다.

## 함정 (구현 필수 준수)

- **HogaMs 비선형**: `gap_ranges`의 start/end는 HHMMSSmmm 인코딩. 경계 비교 전
  `_hhmmssms_to_intra_ms`로 선형 ms 디코드 필수.
- **open_ms=0**: hogaplay meta는 `regular_session_open_ms=0`을 그대로 저장(ADR-0063).
  leading 판정 시 `0 → 09:00` 정규화 폴백.
- **half-day**: close는 meta의 `regular_session_close_ms` 사용(하드코딩 금지).

# 0093 — 확정된 업스트림 결손은 스킵하고 cap을 소모하지 않는다

**Status:** accepted (2026-07-09)

**Related:**
- ADR-0042 — fail_streak cap (이 ADR이 amend; 아래 참조)
- ADR-0020 — DiskState 분류 (SOURCE_PARTIAL 의미)
- WS1 — 업스트림 결손 가시화 (`gap_ranges` 필드, 이 ADR의 지문이 의존)

## Context

hogaplay 아카이브 자체에 특정 시간 구간 데이터가 영구 결손인 거래일이 있다
(실측: 대한항공 003490/20260707, 스냅샷 13:52~14:11). 이런 Stock-Date는
`collection_complete=true`(풀 워크 완료)인데 `is_partial=true`(갭 잔존) →
`SOURCE_PARTIAL`. 재캡처를 아무리 돌려도 업스트림에 데이터가 없어 동일한 갭이
재현되며 절대 `COMPLETE`가 되지 않는다.

ADR-0042의 fail_streak는 done+not-COMPLETE를 +1로 세므로, 이런 날짜는 재시도할
때마다 streak이 쌓여 5회 후 enqueue가 409로 차단된다 — 그 시점부터 사용자는
진짜로 캡처를 못 한다. 게다가 그때까지 매 재시도가 hogaplay에 무의미한 풀 워크
부하를 준다(ADR-0042의 동기 #1 "외부 API 보호"와 정면 충돌).

## Decision

### 1. 동일 결과 지문 + `identical_capture_count`

파서가 prior meta를 읽는 기존 자리(full_capture_count 증가 옆)에서
`identical_capture_count`를 함께 계산한다. 지문은
`(total_unique_events, pages_collected, gap_ranges)`. 직전 캡처와 지문이 같고
**양쪽 모두 `collection_complete=true`**면 `prior + 1`, 아니면 `1`로 리셋한다.
gap_ranges를 지문에 넣어, 같은 이벤트 수라도 다른 창을 채운 캡처는 "변경"으로
취급한다. 업스트림이 치유되어 결과가 달라지면 카운터가 자동으로 1로 풀린다.

### 2. 확정 판정

`Classification.upstream_gap_confirmed = (state == SOURCE_PARTIAL and
identical_capture_count >= 2)`. `>= 2`는 "최초 캡처 + 최소 1회의 풀 재캡처가
동일한 갭을 재현" = 결손이 업스트림에 있음이 확정됐다는 뜻이다.

### 3. 스킵 (외부 호출 0건) — cap 미소모

`decide_capture`(워커 deciding phase)에서
`SOURCE_PARTIAL and upstream_gap_confirmed and not force_retry`면
`skip_reason="upstream_gap"`으로 스킵한다. 이 스킵은 **fetch 이전**에 일어나
외부 호출이 0건이므로, `_apply_terminal_to_streaks`는 이 스킵에 대해 fail_streak를
증가시키지 **않는다**. 스킵이 cap보다 강한 보호(호출 자체를 안 함)이면서
호출 0건이라 streak 미소모가 정당하다. 다른 스킵 사유(already_complete,
source_partial, no_upstream_data)는 기존대로 +1을 유지한다.

### 4. `force_retry` 우회

`force_retry=True`(인벤토리 드로어의 "강제 재캡처" 버튼)면 스킵을 우회해 실제
재캡처를 돈다 — 사용자가 업스트림 치유 여부를 재검증하는 경로. 그 재캡처가
여전히 갭이면 done+not-COMPLETE fail_streak 규칙(ADR-0042)이 여전히 폭주를 막는다.
이로써 legacy였던 `force_retry` wire 필드가 처음으로 실동작을 얻는다(배선은 이미
존재, 분기만 추가).

## Consequences

- 확정 결손 날짜는 무의미한 재캡처로 hogaplay를 때리지 않고 cap도 소모하지 않는다.
  사용자는 드로어에서 결손 구간(WS1)과 "N회 재캡처 동일 결과 — 업스트림 결손 확정"을
  보고, 필요하면 강제 재캡처로 재검증한다.
- 기존 blocked(streak≥5) 항목은 일괄 리셋하지 않는다 — 실제 소진된 시도들이다.
  사용자가 결손을 확인한 뒤 unblock으로 정리하는 흐름(기존 ADR-0042 UX 재사용).
- 레거시 meta에는 `identical_capture_count`가 없어 `upstream_gap_confirmed`가
  항상 False → 기존 동작(재캡처 진행)과 동일. 첫 재캡처가 카운터를 심고, 두 번째
  동일 결과에서 확정된다.

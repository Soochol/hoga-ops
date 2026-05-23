# 20260518 Drain Runaway — Root Cause

**원본:** ~/.local/share/hoga-ops/data/raw/20260518/003490/ (3931 pages, finished=False)

**Summary** (from drain-summary-20260518.txt):
- total_pages: 3931
- post_window_first_idx (max_event_time ≥ 160M): None — 데이터가 공식 윈도우 끝(16:00)에 도달하지 않음
- drain_iterations (실측, page 103~3931): 3829
- post_window_empty_resets: 0 (page 102 이후 new_seqs > 0 없음)
- max_empty_streak_post_window: 3829 (단조 증가 — 리셋 없음)
- avg_reset_gap_pages: N/A

**참고:** `drain-summary-20260518.txt`의 `post_window_first_idx=None`은 스크립트가
`max_event_time ≥ DATA_WINDOW_END_MS(160,000,000ms = 16:00)`를 탐지하도록 작성됐기 때문.
실제 시장 데이터는 ~90,345,810ms(≈09:03:45 KST)에서 끊겼으므로 이 조건은 한 번도 충족되지 않음.
drain 경계는 별도로 측정: page 102가 마지막 new_seqs > 0, page 103부터 3829 페이지가 연속 empty.

## 실제 종료 실패 메커니즘

계획서 템플릿의 가설(산발적 new_seqs가 empty counter를 reset) **은 해당 없음**.
page 103-3931은 new_seqs가 단 한 번도 > 0이 아님.

실제 원인은 `PageStepController.observe()` 내 **cap-hit 판정 로직**:

```python
cap_hit = (
    max_event_time is not None
    and max_event_time < target          # ← 항상 True: 데이터 고갈 후 max_event_time ≈ 90M, target은 계속 증가
    and self._step_ms > self._min_step_ms
    and self._t < self._data_window_end_ms  # ← t가 160M 미만인 한 True
)
if cap_hit:
    self._empty_in_a_row = 0  # ← empty counter가 매 페이지 리셋됨
```

데이터가 고갈된 후에도 `max_event_time(≈90M) < t + step_ms` 조건이 항상 성립하므로
cap-hit로 분류 → `_empty_in_a_row` 매 페이지 리셋 → TERMINATION_EMPTY_PAGES=3 미충족 → 종료 불가.

`t`가 160M(DATA_WINDOW_END_MS)에 도달하면 cap-hit 조건의 마지막 guard
(`self._t < self._data_window_end_ms`)가 False가 돼 cap-hit 판정이 끊기고
empty counter가 3에 도달해 정상 종료됨. 그런데 `t`는
`step_ms`(cap-hit마다 절반으로 줄어 MIN=1000ms에 수렴) 단위로 증가하므로
160M까지 도달하는 데 3829 페이지 이상이 소요됨.

**결론:**
- (a) 종료 실패는 cap-hit이 `_empty_in_a_row`를 지속 리셋해서 발생함 (new_seqs reset 가설 아님)
- (b) 실측 drain 길이: page 103 ~ 3931 = **3829 페이지**
- (c) Task 9 주의사항: `MAX_DRAIN_ITERATIONS_AFTER_WINDOW_END`라는 이름은 약간 오해의 소지가 있음.
  이 캡처에서 `t`는 실제로 window_end(160M)를 통과하기 전에 3829 페이지를 소모했기 때문.
  guard를 "drain 시작(new_seqs가 0이 된 시점)부터의 반복 횟수"로 정의할지,
  "t ≥ window_end 이후의 반복 횟수"로 정의할지 Task 9에서 결정 필요.
- (d) 권장 `MAX_DRAIN_ITERATIONS_AFTER_WINDOW_END` 값:
  실측 drain_iterations(3829) × 1.5 = 5743.5 → **5800** (100 단위 반올림)

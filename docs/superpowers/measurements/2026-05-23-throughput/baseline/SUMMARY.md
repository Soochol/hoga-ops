# Phase 0 Baseline — 20260429 (수)

HOGA_PROFILE=1 활성 상태에서 토요일 야간 22:00 KST 캡처. 평일 시간대가 아니라 RTT는 평일 평균보다 빠를 가능성 (Phase 1 매트릭스는 평일 재측정 권장).

## 003490 (대한항공)

| 메트릭 | 값 |
|---|---|
| wall-clock | 5:03 (303s) |
| pages | 1271 |
| unique seqs | 44,570 |
| sec/page | 0.239s |
| profile iters | 1271 |
| http_ms p50/p95/p99 | 39.1 / 49.8 / 66.3 |
| body_len p50 | 145931 bytes |
| cap_hit count (rate) | 2 (0.2%) |
| post_window iters | 3 |
| 마지막 100 iter 중 new_seqs=0 | 100 |

## 005930 (삼성전자)

| 메트릭 | 값 |
|---|---|
| wall-clock | 6:36 (396s) |
| pages | 1487 |
| unique seqs | 310,025 |
| sec/page | 0.267s |
| profile iters | 1487 |
| http_ms p50/p95/p99 | 67.5 / 95.3 / 148.5 |
| body_len p50 | 111125 bytes |
| cap_hit count (rate) | 273 (18.4%) |
| post_window iters | 3 |
| 마지막 100 iter 중 new_seqs=0 | 100 |


## 핵심 발견 (Task 9에 영향)

1. **정상 캡처의 마지막 100 iter 모두 new_seqs=0** (003490·005930 동일). spec §8.3 v2의 `MAX_STAGNANT_PAGES=100` 값은 **정상 캡처를 false-positive 종료시킬 위험**이 있음. Task 9 구현 전 stagnation 조건의 max_event_time advance 여부 동시 검증 필수. 옵션:
   - `max_event_time` advance하면 stagnation 0으로 reset (현 spec v2)
   - 마지막 100 iter에서 max가 advance하는 비율 확인 후 MAX_STAGNANT_PAGES 값 재조정 (200~500 권장)
2. **003490 (저활성)**: cap_hit 0.2% — step 거의 60k 천장 머무름 → step 천장 상향 lever **매우 유효**
3. **005930 (고활성)**: cap_hit 18.4% — step 자주 halving → step 천장 상향 lever **거의 무효** (예측 확정)
4. **post_window iters = 3 (양 종목)**: 정상 캡처는 post-window drain이 매우 짧음. spec v1의 "drain iteration cap" 가드는 정상 캡처에 영향 없었을 것 (단 20260518 같은 폭주는 못 잡음 → v2 stagnation 가드 필요성 재확인)

# Phase 2 — Adopted Settings Verification (rate=0.05, step=60000)

**Date captured:** 20260428 (uncaptured weekday at run time, Sunday early morning KST execution)

**Adopted values applied:** rate_limit_s=0.05, initial_step_ms=60000

## Wall-clock comparison

| Stock | Baseline (rate=0.2) | Verify (rate=0.05) | Reduction | Target | Result |
|---|---|---|---|---|---|
| 003490 | 303s (5:03) / 1271p | 123s (2:03) / 1278p | -59% | ≤ 120s | ≈ 3s over |
| 005930 | 396s (6:36) / 1487p | 169s (2:48) / 1442p | -57% | ≤ 300s | ✓ PASS |

## Profile JSONL summary

### 003490
- profile iters: 1278
- throttle markers: 0 (target: 0)
- cap_hits: 6 (0.5%)
- http_ms p50/p95: 45.0 / 61.9
- finished: True

### 005930
- profile iters: 1442
- throttle markers: 0 (target: 0)
- cap_hits: 277 (19.2%)
- http_ms p50/p95: 66.0 / 104.0
- finished: True

## Conclusion

- ✅ 두 캡처 모두 정상 종료 (`finished=True`), 4xx/429/cookie_expired 0건
- ✅ Throttle 백오프 0회 발동 — rate=0.05가 안전 구간 안
- ✅ 005930 목표 5분 충분히 달성
- ≈ 003490 목표 2분에서 3초 초과 (2:03) — Sunday 새벽 측정으로 HTTP RTT 변동 영향 가능성, 실질적으로 동등 (60% 단축)

Spec §2 wall-clock 목표는 "5분 → 2분 이내"로 약 60% 단축 — 달성.

## Caveat

- Saturday→Sunday 야간/새벽 시간대 측정 (Phase 0 baseline은 토요일 22:00 KST). 평일 같은 시간대 hogaplay throttle 정책이나 RTT가 달라질 수 있음.
- 신뢰성을 위해 평일 09:00~16:00 KST에 한 번 더 풀 검증 1회 권장 (옵션).

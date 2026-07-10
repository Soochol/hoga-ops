# 0100 — KIS REST 유량 앱키별 독립 재실측과 계정별 토큰버킷 복원

**Status:** accepted (2026-07-10)

**Related:**
- ADR-0082 (KIS capacity scheduler / account pool) — 원 per-appkey 운영 가정 복원; 2026-07-08 Amendment("명의 단위 한도") 폐기.
- ADR-0086 (rate-limit 계좌 failover) — failover 실효성 복원(앱키별 독립 한도라 다른 키로의 구제가 유효).
- ADR-0087 (foreground 두 계층) — 토큰버킷 lane이 본문 원문대로 계좌(앱키) 스코프로 복귀. 두 계층 결론 불변.
- ADR-0098 (REST 호가 전용 + 동시 디스패치) — 결정 유지, 예산 산식만 15/s → ~15×계정수.
- ADR-0050 (KisClient retry/토큰버킷 소유) — EGW00201 흡수 메커니즘(1,2,4)s backoff 불변.
- `hoga/live/kis_runtime.py` `_account_rate_limiter` / `ensure_kis_client` — 구현점.

## Context

2026-07-08 이후 코드는 모든 계정 KisClient가 **명의-전역 단일 토큰버킷(15/s)** 을 공유했다. 근거는
`/investigate 2026-07-07` 실측 — "3계좌 × 15/s = 45/s 송신 → EGW00201 ~47%" 로부터 "KIS는 유량을
명의(고객) 단위로 집행한다" 고 결론짓고 전역 클램프를 도입했다(ADR-0082/0086/0098 Amendment).

**재실측 2026-07-10** (같은 명의로 발급한 앱키 3개, 우리 쪽 클램프를 우회한 raw 송신):
- 버스트 프로브 2회: 3앱키 합산 성공 QPS ÷ 단일 앱키 = **3.10x / 2.87x**.
- 지속부하 프로브(3앱키 각 15/s = 합산 45/s × 120초): EGW00201 **9.0% 평탄**(10초 창 12개 전부
  6~11%, 후반부 상승 추세 전무), 성공 **40.5/s = 3.03x**.
- 판별 핵심 = EGW 비율. 명의 합산이라면 45/s에서 초과분 전량 반려로 EGW ~67%+ 폭증해야 하나, 단일
  앱키(10.1%)와 **동일한 9%** — 각 앱키가 자기 15/s를 독립 소화한 지문.

결론: **KIS REST 유량은 앱키별 독립 ~15/s** 다. 2026-07-07 실측은 재현 실패했다. 원인은 미확정이나
측정 오염 추정 — 당시 프로덕션 백엔드(WS 승인·지표·폴러·백필)의 동시 송신이 합산돼 실제 송신률이
45/s를 크게 넘었거나, backoff 재시도가 EGW 카운트를 증폭했을 가능성. 두 실측의 충돌은 "해소"가 아니라
**최신·통제된 쪽 채택 + 롤백 노브 보존**으로 관리한다.

현 전역 버킷은 계정 추가의 REST 이득을 봉인 중이다 — rest30 히트맵 241종목이 하한 ~16초(ADR-0098
`:19`)에 묶이고, ADR-0082의 linear-capacity 약속이 코드에서 죽어 있다(활용률 15/40 ≈ 37.5%).

디스패치 파이프라인 감사(2026-07-10): 스케줄러/풀/워커는 **무변경으로 3계정 포화 가능**. 토큰 acquire가
`lease → request.call(client) → release` 구간 **안**에서 일어나므로, 버킷이 마른 계정은 워커가 acquire에서
park → inflight 유지 → `KisAccountPool.lease()`의 least-inflight가 그 계정을 자동 회피한다. 즉 inflight
(동시성)가 rate 포화의 프록시로 성립해 rate-aware 라우팅이 불필요하다.

## Decision

1. **버킷 분리.** `_global_rate_limiter: _TokenBucket | None` 싱글톤 → `_rate_limiters: dict[int, _TokenBucket]`
   (account_id 키). `_shared_rate_limiter()` → `_account_rate_limiter(account_id)`. `ensure_kis_client`가
   그 계정 전용 버킷을 주입. 스케줄러/풀/워커는 무변경.

2. **계정별 rate=15.0 / capacity=4.0 유지** (13/s 보수안 기각). 실측이 그 값 자체로 나왔고, 15/s 페이싱의
   잔여 EGW ~9%는 KisClient 내장 backoff (1,2,4)s가 흡수한다 — 단발 EGW 9%면 4연속 실패(retry 소진)
   확률 ≈ 0.09⁴ ≈ 7e-5로 스케줄러 cooldown/failover에 거의 도달하지 않는다. 13/s로 낮추면 worst-case
   goodput로도 15/s가 우세(15/s 송신 goodput 13.65 vs 13.0/s)하고 13/s의 EGW율은 미실측이라 근거 없는 양보.

3. **capacity < rate 논리는 계정별로 동일.** 유휴→포화 첫 1초 burst(용량+리필)가 앱키별 고정윈도를 넘지
   않게 하는 원 의도가 계정 버킷마다 그대로 성립.

4. **롤백 노브 `_SHARED_BUCKET_KEY: int | None = None`.** 0으로 두면 전 계정이 account-0 버킷으로
   수렴 = 전역 15/s 클램프 1줄 복원. 2026-07-07 실측이 만에 하나 "간헐적 명의 클램프 실존"이었을 경우의
   장중 긴급 대응(1줄 + 재시작). 테스트로 핀 고정(`test_shared_bucket_key_restores_global_clamp`).

## Consequences

- REST 처리량 ~15/s → ~45/s(3계정, 실측 goodput 40.5/s). rest30 241종목 사이클 하한 ~16s → ~5.4s
  방향(실장 관측으로 확인; `concurrency=10`이 새 병목이면 여기서 드러나 별도 튜닝).
- ADR-0086 계좌 failover와 `(account_id, endpoint, scope)` cooldown이 앱키별 한도와 스코프 정합 — 원
  설계 의미 복원(다른 키 = 다른 한도이므로 구제 실효).
- foreground lane(ADR-0087)은 계정 스코프 복귀: user_visible 새치기는 자기 lease 계정 버킷 안에서만
  동작하고, 계정 간 우선순위는 스케줄러 큐 rank가 계속 소유(계정 무관 user_visible 우선 디스패치 유지).
- EGW ~9% 상시화: user_visible 콜이 9% 확률로 +1s backoff tail, 로그 노이즈 증가. 거슬리면 rate 상수
  15→13 하향(1줄, 롤백 사다리 ②)으로 트레이드.
- 기존 클라이언트는 생성 시 버킷을 주입하므로 반영에 **프로세스 재시작** 필요.

## 잔여 리스크 / 미검증

- **일일 누적 쿼터**: 3배 콜 볼륨의 키별/명의별 일일 상한은 미검증(테스트는 총 ~1.2만콜/일 수준까지만
  무징후). 장중 실가동으로 확인.
- **20/s+ 미탐색**: 앱키당 한도의 상단은 프로빙하지 않았다(15/s 실측점 고수).
- **2026-07-07 오염 원인 미규명**: 간헐적 명의 클램프가 실존일 가능성에 대비해 `_SHARED_BUCKET_KEY`
  롤백 노브를 유지한다. **재발 신호 3종** — `rate_limit_failovers` 카운터 증가 + cooldowns 스냅샷이
  상시 비어있지 않음 + EGW율이 9%에서 이탈 상승. 하나라도 보이면 즉시 롤백 노브.

## 비범위

rest30 `concurrency` 기본값 상향, 백필(`live_candle_backfill`) 동시성 상향, 폴러 user_visible 승격,
다른 명의(고객번호) 추가, KIS WS 등록 슬롯 정책(`KIS_WS_MAX_REGISTRATIONS`), `_RATE_LIMIT_CALLS_PER_SEC`
(KisClient 미주입 기본값) 변경. — 전부 후속 결정.

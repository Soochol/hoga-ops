# 0098 — REST 캡처 호가 전용 통일 + rest30 동시 디스패치

**Status:** accepted (2026-07-10)

**Related:**
- ADR-0097 (히트맵 종목을 rest30 REST-전용 후보로 합류) — 이 부하 문제의 발단.
- ADR-0067 (rest_poller = 보는 종목 표시 폴러, 디스크 저장 없음) — 폴러도 호가 전용으로 통일.
- ADR-0038 (JSONL 핫패스 → parquet 승격) — 저장 경로 무변경 상속.
- `hoga/live/rest30_recorder.py` · `hoga/live/rest_poller.py` (구현점).
- `hoga/live/kis_runtime.py:118` `ensure_kis_client` / `_shared_rate_limiter` — 명의-전역 15콜/s 콜레이트의 단일 진실.

## Context

ADR-0097로 히트맵 종목이 `Rest30sRecorder`의 `kis_api_targets`에 합류했다. 장중 실측(2026-07-10, 241종목): 호가 스냅샷이 명목 30초가 아니라 **실측 2~3분** 간격으로 성기게 저장돼, 1분봉의 매도/매수 총잔량 지표가 거의 안 나온다(1분 버킷 채움률 ~16%).

두 가지 근본 원인:

1. **직렬 디스패치.** `poll_once`가 `for code: await`(코드 내부도 3콜 순차)라, 왕복지연에 묶여 명의-전역 15콜/s 예산 중 ~5콜/s만 쓴다. 게이트는 여유가 있는데 차를 한 대씩만 보내는 상태.
2. **콜레이트 상한이 15콜/s 전역(명의 단위).** `ensure_kis_client`가 모든 계정 클라이언트에 `_shared_rate_limiter()`(전역 토큰버킷, `_GLOBAL_KIS_RATE_PER_SEC=15`)를 주입한다 — docstring 명시대로 "KIS enforces the limit per customer, not per app key". 즉 **키/계정을 늘려도 같은 명의면 REST 콜레이트는 15콜/s 그대로**다. 따라서 완벽히 파이프라이닝해도 241종목×3콜=723콜은 15콜/s로 **하한 ~48초** — 30초에 물리적으로 못 들어간다.

**정정(CONTEXT.md 갱신):** 기존 CONTEXT의 "KIS REST limit 은 account/appkey 단위라 계정을 늘리면 capacity 가 `healthy_accounts * 15 calls/sec` 로 증가한다"는 가정은 현행 코드(전역 공유 버킷)와 어긋난다. 한 명의 안에서는 계정 수와 무관하게 15콜/s가 상한이고, 계정 풀은 WS 등록 슬롯·레이트리밋 페일오버·워커 동시성을 위한 것이지 REST 콜레이트 증설이 아니다.

## Decision

**REST는 전부 10호가(orderbook)만 수집하고, rest30은 동시 디스패치한다.**

예산 산식: 15콜/s = 30초당 450콜. 종목당 1콜(호가)이면 450종목/30초 → 241종목은 ~16초에 소화. 종목당 3콜이면 150종목/30초라 241종목은 불가.

1. **동시 디스패치 (rest30).** `poll_once`의 직렬 루프를 `asyncio.Semaphore(concurrency)` + `gather`로 교체. 코드 내부는 순차 유지, per-code try/except로 격리(한 종목 실패가 gather를 취소하지 않음). 실제 콜레이트는 공유 토큰버킷이 15콜/s로 클램프하므로 과플러딩 없음. 기본 `concurrency=10`(포화에 필요한 in-flight ≈ rate×latency ≈ 8 + 여유; 과하면 user_visible 대기창만 커짐).
2. **REST 호가 전용.** rest30·rest_poller 둘 다 `fetch_orderbook` 1콜만 fetch/publish/저장. `capture_aux: bool = False`(기본) 파라미터로, True면 기존 호가+체결+거래원 3콜 복원. **총잔량은 호가만 필요**하고, 체결·거래원 실시간·저장은 **WS(관심종목) 전용**으로 통일한다.
3. **고정 벽시계 경계 스케줄링.** `_run_loop`의 `poll → sleep(interval)`(위상 밀림)을 `_next_delay_s`(다음 interval 경계까지 대기)로 교체. 사이클이 interval을 넘겨도 다음 경계에서 즉시 재개(밀리지 않음). `stream.py`의 `_next_window_delay_s` 미러.

## Consequences

- **총잔량 밀도 복원:** 호가 스냅샷 ~2~3분 → ~16~30초(사이클 ~16초, 기본 `interval_s=30`에서 30초 정착; 더 촘촘히 원하면 `interval_s`를 20으로 낮춤 — 예산상 가능). 1분봉 총잔량 채움률 16% → ~100%(서버 가동시간 한정).
- **체결·거래원 상실(의도된 트레이드오프):** REST 전용(히트맵 + 관심종목 WS 초과 스필오버) 종목은 체결·거래원이 **저장도 실시간 표시도 안 된다**(폴러까지 호가 전용). 체결분포·체결강도·거래원 지표가 그 종목엔 빈칸. 필요하면 관심종목(WS)으로 승격. 관심종목이 WS 슬롯(~30종목) 안이면 스필오버가 없어 사실상 히트맵 종목만 해당.
- **부작용(작음):** 동시 10이라 사용자 대면 콜(차트 백필)이 최악 ~0.7초(=10/15) 일회성 대기 가능 — 스케줄러의 우선순위 양보(큐 새치기 + dequeue 후 재큐잉)가 이후를 방어. rest_poller도 `background`라 보는 종목 갱신이 미세하게 흔들릴 수 있으나, 폴러의 `user_visible` 승격은 이번 범위 밖(ADR-0067 원 분류 유지).
- **디스크:** 호가 스냅샷 밀도↑로 JSONL append·Today-Promoter 승격 파싱량 증가(종목당 수백 KB/일 수준, 감당 범위).
- `concurrency`·`capture_aux`는 생성자 파라미터라 실장 관측(`LiveStatus.last_cycle_duration_ms`) 후 조정 가능. 되돌림은 `capture_aux=True` 한 줄.

## 비범위

폴러 `user_visible` 승격, 대상 티어링(핫/콜드), 체결·거래원 별도 느린 루프, `capture_aux`의 UI 토글, 글로벌 레이트 15→상향, 다중 명의로 콜레이트 증설.

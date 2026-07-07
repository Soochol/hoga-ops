# 0088 — 배경 태스크는 감독 통합이 아니라 관측 노출로 다룬다

**Status:** accepted (2026-07-07)

**Related:**
- ADR-0064 — 라이브 poller 침묵 사망 + 캘린더 게이트 (정직 health 패턴의 출처)
- ADR-0043 — Today Promotion (today_promote_last_ms health 필드)
- ADR-0082 / 0086 — KIS Capacity Scheduler 워커 (자체 재생성)
- ADR-0019 — Capture Queue restore-before-spawn (워커 풀)

## Context

아키텍처 리뷰에서 백엔드의 장기 실행 배경 asyncio 태스크 감독 구조를 전수
매핑했다. 발견:

- **세 폴러**(`LiveRestPoller`, `Rest30sRecorder`, `ProgramTradeCollector`)가
  거의 동일한 lifecycle을 각자 구현한다: `start()`/`stop()`, `alive =
  task is not None and not task.done()`, `last_cycle_ms` 성공 신호, 이중 격리
  try/except(사이클 격리+backoff, 항목별 skip).
- **자가 재시작 감독이 없는 fire-and-forget 태스크들**: `watchlist-daily-loop`,
  `watchlist-catchup`, `today-promoter`, 그리고 `live-stream-watchdog` **자체**.
  죽으면 프로세스 재시작만이 부활 경로다.
- **`watchlist-daily-loop`의 health가 `/api/live/status`에 노출되지 않는다** —
  이 루프가 침묵 사망하면 일일 enqueue가 멈춰 Capture Queue가 고착되는데,
  그 죽음이 어디에도 보이지 않는다. 이는 ADR-0064가 고쳤던 바로 그 실패 클래스
  (감독 없는 루프의 침묵 사망 + 관측 부재)가 다른 태스크에 남아 있는 것이다.

초기 리뷰 후보는 "`supervised_task(name, factory, restart_policy)` 공통 seam을
신설해 모든 배경 태스크를 통합 감독한다"였다. 그러나 조사 결과 이 통합은
**net-negative**로 판단되어 범위를 축소한다.

## Decision

**통합하지 않는다. 대신 관측 갭만 닫는다.**

1. **관측 노출 (채택, 구현됨).** `AppStartupRuntime.supervised_task_health()`가
   lifespan-소유 태스크(`scheduler_tasks` = daily-loop/catchup/symbols-boot,
   `live_watchdog_task`, `today_promoter_task`) 각각의 alive 여부를
   `[{name, running}]`로 반환한다. `/api/live/status`가 `app.state.startup_runtime`
   경유로 이를 읽어 `LiveStatus.supervised_tasks`에 병합한다(additive 필드).

   **정직 health 규칙(ADR-0064 승계).** `running`은 `task is not None and not
   task.done()` — **staleness가 아니다.** `watchlist-daily-loop`는 발화 사이
   ~23시간 잠자므로, last-activity 기반 신호는 하루 23시간을 거짓 경보한다.
   잠자는(살아있는) 태스크는 healthy로, `done()`(침묵 사망)은 unhealthy로 보고한다.

   **watchdog-for-watchdog는 두지 않는다.** `live-stream-watchdog` 자체가
   무감독이라는 갭도 **재시작 감독이 아니라 관측 노출로** 닫는다 — 중첩 감독자는
   ADR-0064가 피하려던 회귀 표면이고, "보이는 죽음은 감지 가능한 죽음"이면 충분하다.

2. **감독 통합 seam 유보 (기각).** 범용 `supervised_task` seam은 만들지 않는다.

3. **3-폴러 base-class 추출 유보 (기각).** `AbstractPollerTask` 공통 기반은
   만들지 않는다.

## Why 통합을 기각하나

**범용 seam — value/risk가 뒤집혀 있다.** 세 부류의 태스크는 서로 다른 계약을
갖는다: 폴러 lifecycle(주기 순회+backoff), 일회성 fire-and-forget(daily-loop),
다른 태스크를 재시작시키는 감독자(WS watchdog). 이들을 하나의 fuzzy 계약으로
묶으면 각 계약이 흐려지고, **blast radius가 하필 하루치 캡처를 통째로 날린 적
있는 그 버그 클래스(ADR-0064)에 떨어진다.** 이득(코드 통일)보다 손실(검증된
감독 코드 불안정화)이 크다.

**3-폴러 추출 — deletion test 실패.** 폴러 3개의 중복은 실재하지만 그것은
*안정된 lifecycle 보일러플레이트*(start/stop/alive/backoff)이지 도메인 로직이
아니다. 가상의 `AbstractPollerTask`를 삭제한다고 상상하면 복잡성이 호출자들로
*재출현하지 않는다* — 각 폴러는 여전히 독립적으로 성립하고, 단지 올바른
보일러플레이트가 세 벌 있을 뿐이다. 추출하면 각 폴러의 이야기가 base+subclass로
쪼개져(라이브 캡처 코드에서 locality 비용) ~40줄 DRY를 얻는다. 이는 deepening을
가장한 lateral movement다.

## Consequences

- `watchlist-daily-loop` 등 무감독 루프의 침묵 사망이 `/api/live/status`의
  `supervised_tasks`에서 즉시 보인다(`running: false`). 운영자/프론트가 감지 가능.
- 세 폴러와 감독 구조는 현행 유지 — 각자 ADR(0064 등)로 이미 검증됨.
- 미래 아키텍처 리뷰가 "3개 폴러 base-class로 묶어라"를 재제안하면, 본 ADR이
  그 답변이다(deletion test 실패 근거).

## Future signal to revisit

- 네 번째, 다섯 번째 폴러가 추가되어 보일러플레이트 복제가 실제 유지보수 사고로
  이어질 때 — 그때는 base-class 추출의 locality 비용 대비 이득이 역전될 수 있다.
- fire-and-forget 루프의 침묵 사망이 관측 노출만으로 부족하다는(자동 복구가 실제로
  필요하다는) incident가 보고될 때 — 그 특정 루프에 한정한 감독을 추가한다
  (범용 seam이 아니라).

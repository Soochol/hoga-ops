# ADR-0064: 라이브 poller 침묵 사망 + 캘린더 게이트 정상화

## Status
Accepted (2026-06-05)

## Context
2026-06-05(금) 장중, `/live`의 10호가가 표시되지 않았다. KIS·인증·네트워크·파싱·프론트
데이터 경로는 전부 정상이었다 — `/api/live/quotes`, `fetch_orderbook/trades/brokers`
standalone 호출 모두 실제 호가를 반환했다. 그러나 라이브 poller가 **그날 단 한 사이클도
완주하지 못한 채** 멈춰 있어 호가 in-memory 버퍼가 비었다.

증거 사슬:
- `/api/live/status`: `running:true` 인데 `last_tick_ms:null`, `kis_calls_today:0`.
- 오늘자 JSONL 0건. watchlist `last_success_date`는 전일까지(어제는 정상 캡처).
- `kis_calls=0` **AND** `last_tick=null` → 첫 사이클의 **첫 fetch 진입 전**에 멈춤
  (사이클 내부에서 죽었다면 `kis_calls≥3`이어야 함).
- 전체 프로세스 리로드(새 싱글턴) 후에야 복구. control-start(`stop→start`, 싱글턴
  재사용)로는 복구 안 됨.

원인은 두 겹이다 — 하나는 **확정**, 하나는 **유력 가설**.

1. **트리거(유력 가설, 재현 불가) — 캘린더 게이트의 거짓 False.** `_should_poll_now`가 거래일 판정에
   `calendar.is_trading_day`(→ `_trading_days_for` → `pykrx.get_market_ohlcv`)를 썼다.
   일별 OHLCV의 **오늘 봉은 장중/마감 전까지 발행되지 않으므로**, 살아있는 거래일이
   장 초반엔 "거래일 아님(False)"으로 읽힌다. 게이트는 `verdict is not False`라 False면
   폴링을 닫고 `run_forever`는 `sleep(1)` 후 continue만 반복 → 영구 idle.
   (`_month_cache`는 성공 페치만 캐시하므로 None은 못 박지 못하지만, OHLCV가 오늘을
   제외한 "성공" 집합을 한 번 캐시하면 그 False가 프로세스 수명 내내 고정된다.)
   *단 이 트리거는 직접 증명되지 못했다*: 죽은 태스크는 리로드로 대체된 뒤에야 계측이
   들어가 09:22의 `_month_cache` 실측을 못 잡았고, 10:43엔 두 소스가 일치했다.
   `kis_calls=0 ∧ last_tick=null`(첫 fetch 전 정지)에 부합하는 두 설명(게이트 False /
   첫 사이클 진입 전 crash) 중 OHLCV-lag가 가장 정합적인 가설이다. 아래 수정은 두 설명
   모두를 헤지한다(① 게이트 False, ②④ crash).

2. **증폭(확정) — 침묵의 사망 + 거짓 health.**
   - `run_forever` 루프에 try/except·감독이 없었다. 게이트나 사이클이 한 번 raise하면
     `asyncio.create_task`가 만든 태스크가 죽는데, `_state.poller_task`가 참조를
     붙들어 GC되지 않으므로 "Task exception was never retrieved" 경고조차 안 뜬다 —
     **traceback 한 줄 없는 영구 사망.**
   - `get_status().running = (_state.started_at_ms is not None)` 이라, 태스크가 죽어도
     `running:true`를 보고했다. 죽은 캡처 루프를 가린 거짓 health 신호.

배제된 가설(증거 기반): 게이트 raise(`is_trading_day`는 절대 raise 안 함, None 반환),
KIS fetch hang(httpx `timeout=10` + 전 예외 캐치), 이벤트루프 블록(장애 중 /status·
/quotes 응답), 싱글턴 오염(장애 중 /quotes가 같은 싱글턴으로 성공).

## Decision
네 가지를 함께 적용한다.

1. **달력 기반 거래일 게이트.** `calendar.is_trading_session_today(today)` 신설 —
   `pykrx.stock.get_previous_business_days`(거래일 **달력**, OHLCV 발행과 무관)로 오늘이
   장중에도 거래일로 표시된다(10:43 관측 + 달력 의미상 그러하나, 09:00 개장 직후 시점은
   미검증 — 만약 이 소스도 개장 직후 오늘을 빠뜨린다면 아래 음성 비캐시 설계로 ~60s 내
   자가치유로 격하될 뿐 종일 장애는 아니다). `_should_poll_now`는 이걸 쓰고, 주말은 `weekday() >= 5`
   로 **KRX 호출 전에 단락**한다(KRX 불가 시 None→lenient라 주말 폴링을 막기 위함).
   양성(True)은 일별 캐시, **음성(False)은 영구 캐시 안 함**(throttle된 재확인)으로,
   소스가 일시적으로 오늘을 빠뜨려도 **프로세스 재시작 없이 자가치유**한다.
   `is_trading_day`/`_trading_days_for`/`trading_days_in_range`/`/calendar`는 미래
   거래일 의미(OHLCV 기반)가 다르므로 **건드리지 않는다**(블래스트 반경 0).

2. **run_forever 감독.** 루프 바디(게이트+사이클)를 try/except로 감싸 transient raise는
   로그 후 한 사이클 백오프하고 continue한다. `CancelledError`(BaseException)는 잡지
   않아 `stop_live_poller`의 cancel은 그대로 종료된다. lifecycle의 `today-promoter`
   루프와 동일한 감독 패턴.

3. **정직한 health.** `get_status().running = (task is not None and not task.done())`.
   gated-idle(사이클 사이 대기) 태스크는 `done()`이 아니므로 여전히 running=true,
   죽은 태스크는 running=false.

4. **watchdog 자가치유.** `start_live_poller_watchdog`(lifespan 배선)이 ~30s마다
   장중에만: poller가 시작됐는데 태스크가 없거나 끝났으면(crash), 또는 살아있어도
   `stale_after_ms`(~2분) 내 tick이 없으면(가동 그레이스 경과 후) `start_live_poller`로
   재시작한다. 오프아워/미시작 시 no-op. watchdog 자체도 self-supervised.

## Consequences
- 장중 거래일은 개장 직후부터 게이트가 열린다(이전엔 OHLCV 오늘 봉 발행 전까지 닫혀
  개장 수십 분을 잃을 수 있었고, 최악엔 그 거짓 False가 캐시돼 하루 종일 닫혔다).
- 평일 공휴일엔 `is_trading_session_today`가 False를 반환하므로 폴링이 닫힌다(휴일 스킵
  보존). 단 음성을 영구 캐시하지 않아 ~60s마다 가벼운 달력 재확인이 발생한다(세션
  재사용, 허용 범위).
- transient 예외/오판이 더는 하루 캡처를 침묵으로 죽이지 못한다. status가 정직해지고
  watchdog이 복구한다.
- `_should_poll_now`가 더는 `is_trading_day`(OHLCV)에 의존하지 않는다 — 게이트 테스트는
  `is_trading_session_today`를 patch하도록 갱신.

## Alternatives considered
- **게이트에서 거래일 판정 제거(평일이면 무조건 폴링).** 거래일 데이터 0 손실이지만
  평일 공휴일에 KIS를 헛호출하고 휴일 인식을 버린다. 기존 "휴일 스킵" 테스트/의도와
  충돌해 기각.
- **`_trading_days_for`를 `get_previous_business_days`로 전면 교체.** `trading_days_in_range`
  /`/calendar`가 의존하는 미래 거래일·과거월 전체 의미가 달라져 블래스트 반경이 큼. 기각.
- **watchdog만(캘린더 미수정).** 게이트 False는 예외가 아니고 재시작해도 같은 캐시를
  읽으므로 watchdog로 안 풀린다. 트리거 수정(①)이 필수.

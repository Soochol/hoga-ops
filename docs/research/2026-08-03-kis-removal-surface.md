# KIS 삭제 표면 전수조사 — 삭제·이사·대체 3분류

- 티켓: [#1010](https://github.com/Soochol/hoga-ops/issues/1010) (지도 [#1005](https://github.com/Soochol/hoga-ops/issues/1005))
- 조사일: 2026-08-03
- 성격: 코드베이스 정적 조사(자격증명 불요). 설계 판단은 하지 않는다 — 목록만 만든다.
- 선행 참조: [#682 KIS WS 삭제 표면 전수조사](https://github.com/Soochol/hoga-ops/issues/682)의 REST 판

## 요약

| 축 | 수치 |
|---|---|
| 백엔드 KIS 모듈 | **13파일 / 3,280줄** |
| KIS 전용 테스트 | **20파일 / 5,317줄 / 218 테스트 함수** |
| KIS 를 참조하는 테스트 파일 총계 | **95파일** (전용 20 + 간접 75) |
| 프론트 KIS 참조 파일(비-테스트) | **52파일** |
| KIS 를 언급하는 ADR 문서 | **56개** |

**핵심 결론: 3,280줄 중 순수 삭제는 1,574줄(48%)뿐이다.** 나머지 절반은 (a) 브로커 중립 개념이 KIS 파일명 아래 잘못 놓여 있어 **이사**해야 하거나, (b) 삭제하되 **키움 대체물이 먼저 있어야** 지울 수 있다. "KIS 파일을 지운다" 는 작업 크기 추정이 절반 이상 빗나간다.

---

## 1. 백엔드 모듈 4분류

### A. 순수 삭제 — 비-KIS 소비자 0

| 파일 | 줄수 | 근거 |
|---|---|---|
| `hoga/live/kis_endpoints.py` | 1,162 | TR 9종 파서·요청 조립. 외부 소비자 0(전부 `kis_client` 경유) |
| `hoga/live/kis_token_provider.py` | 220 | KIS 토큰 발급·캐시 |
| `hoga/live/kis_account_pool.py` | 123 | KIS 계정 풀(ADR-0100 날짜병렬의 근간) |
| `hoga/live/kis_errors.py` | 69 | 도메인 에러 타입. 외부 노출은 `kis_client` 재수출뿐(`kis_client.py:49`) |
| **소계** | **1,574** | |

### B. 삭제하되 키움 대체물이 선행 — 소비자 다수

| 파일 | 줄수 | 비-KIS 소비자 | 대체 책임 |
|---|---|---|---|
| `hoga/live/kis_client.py` | 477 | **12** | #1011 공용 seam |
| `hoga/live/kis_capacity_scheduler.py` | 303 | 5 | #1011 유량 거버너 |
| `hoga/live/kis_runtime.py` | 277 | 5 | #1011 리소스 소유 계층 |
| `hoga/live/kis_access.py` | 123 | **10** | #1011 — **테스트 시임 포함**(함정 ③) |
| `hoga/live/kis_capacity_runtime.py` | 99 | 5 | #1011 |
| **소계** | **1,279** | | |

`kis_access.py` 의 docstring 이 계층 분리를 명시한다 — `kis_runtime`=리소스 소유, `account_health`=저하 판정, `kis_access`=엔드포인트 enum + 스케줄러 어댑터. **#1011 이 설계할 키움 계층은 이 3층을 그대로 참고할 수 있다**(현재 키움엔 이 층이 통째로 없다).

### C. 이사·리네임 — KIS 가 아니다

| 파일 | 줄수 | 소비자 | 실체 |
|---|---|---|---|
| `hoga/live/kis_models.py` | 59 | 6 | 함정 ① |
| `hoga/live/kis_venue.py` | 93 | 6 | 함정 ② |
| **소계** | **152** | | |

### D. 갭·마스터 판정에 후행

| 파일 | 줄수 | 소비자 | 판정 티켓 |
|---|---|---|---|
| `hoga/api/kis_holidays.py` | 168 | 3 (`calendar.py` 지연 import) | [#1013](https://github.com/Soochol/hoga-ops/issues/1013) |
| `hoga/api/kis_master.py` | 107 | 2 (`symbols.py`) | [#1014](https://github.com/Soochol/hoga-ops/issues/1014) |
| **소계** | **275** | | |

---

## 2. 새어나간 심볼 — 삭제 PR 의 실제 크기

`hoga/live/kis_*.py` 밖에서 import 되는 KIS 심볼 전수:

| 심볼 | 원 모듈 | 새어나간 곳 |
|---|---|---|
| `KisCandle` | `kis_models` | `api/app.py`, `live/candle_fetch_result.py`, `live/candle_repair.py` |
| `IndexCandlePoint` | `kis_models` | `live/candle_fetch_result.py`, `live/index_candles_cache.py`, **`live/kiwoom_index_candles.py`** |
| `InvestorTrendEstimateRow` | `kis_models` | `live/api.py` |
| `KisVenue` / `LiveVenuePolicy` | `kis_venue` | `live/api.py`, `live/past_candles_cache.py`, `live/past_daily_candles_cache.py`, `live/live_candle_backfill.py`, `live/live_daily_candle_backfill.py` |
| `KIS_KST` | `kis_venue`(재수출 `kis_client`) | `api/screener.py`, `api/screener_backfill.py`, `live/index_candles_cache.py`, `live/past_daily_candles_cache.py` |
| `KisQuote` | `kis_client` | `live/api.py`, `live/quote_change_resolver.py` |
| `KisApiError`·`KisAuthError`·`KisRateLimitError`·`KisTransportError` | `kis_errors`(재수출 `kis_client`) | `live/error_policy.py`, `live/api.py`, `live/live_candle_backfill.py`, `live/live_daily_candle_backfill.py`, `live/live_index_investor_net.py`, `live/session_gate.py` |
| `KisCapacityCooldown`·`KisCapacityOverloaded` | `kis_capacity_scheduler` | `live/api.py` 외 4곳 |
| `run_with_capacity`·`has_rest_capacity`·`kis_rest_bypass_enabled`·`KisRestEndpoint` | `kis_access` | 10파일 |

---

## 3. 함정 — 순진한 삭제가 깨지는 지점 7건

### ① `kis_models.py` 는 KIS 모듈이 아니다 — 코드가 그렇게 말한다

`kis_models.py:13-18` 원문:

> `KisCandle` — **"브로커 중립 캔들 포트 — 이름의 "Kis" 는 역사적이다.** 현재 생산자는 KIS REST 캔들 파서뿐이지만(키움 분봉 딥백필은 ADR-0120으로 제거), 캔들 캐시·백필 사다리는 **소스 무관으로 소비한다.** 리네임은 22개 사용처 파급이라 보류(2026-07-20 감사)"

즉 **삭제 대상이 아니라 이사·리네임 대상**이다. 같은 파일에 선례도 있다 — `ProgramTradeByStockRow` 는 공급원이 KIS REST → 키움 `0w` 로 바뀌자 `program_trade_store.py` 로 이사했다(`kis_models.py:58-59`). `KisOrderbook`/`KisTrade`/`KisBrokers` 는 소비자 0 이 되어 삭제됐다. **이 파일은 이미 두 번의 이관을 겪었고 그때마다 "이사 아니면 삭제" 를 소비자 수로 판정했다.** 같은 문법을 적용하면 된다.

### ② `kis_venue.py` 도 절반은 거래소 개념이다

- `KIS_KST = KST` — 주석이 명시한다: **"정본은 `hoga.util.timeenc.KST` 하나다 — 벤더별로 다른 값이 아니다."** 소비자를 정본으로 돌리면 그냥 사라진다.
- `KisVenue = Literal["KRX", "NXT", "UN"]` — **거래소 개념**이지 KIS 개념이 아니다. 키움도 KRX/NXT/UN 을 다룬다(ADR-0118 의 venue 스왑).
- 실제 KIS 전용은 `_KIS_DIV`(`J`/`NX`/`UN` wire 인코딩)와 `_EMPTY_PAGE_PREVIOUS_ANCHORS`(KIS 분봉 빈 페이지 앵커) **둘뿐**이다.

### ③ `kis_access` 가 테스트 스위트의 페이크-브로커 시임이다 ← 가장 중요

몽키패치 지점 실측 — 압도적 다수가 `kis_access.run_with_capacity` 와 `kis_runtime.*` 에 걸려 있다:

```
"hoga.live.kis_access.run_with_capacity", fake_run_with_capacity / never_returns / raise_cooldown / raise_overloaded
_screener_mod.kis_access, "run_with_capacity" / "has_rest_capacity"
live_api.kis_access, "run_with_capacity" / "has_rest_capacity"
kis_runtime, "configured_account_ids" / "get_kis_client" / "ensure_kis_client_from_env"
candle_repair.kis_access, "kis_rest_bypass_enabled"
```

**`kis_access` 를 지우면 테스트가 브로커를 가짜로 바꿔 끼우는 유일한 이음매가 사라진다.** 이건 구현 세부가 아니라 **#1011 의 설계 요구사항**이다 — 키움 계층은 동등한 "한 함수만 몽키패치하면 전 호출자가 페이크로 바뀌는" seam 을 제공해야 한다. 제공하지 않으면 75개 간접 테스트 파일이 각자 다른 방식으로 페이크를 만들게 된다.

### ④ `error_policy.py` 는 브로커 중립 기계인데 KIS 예외로 디스패치한다

`hoga/live/error_policy.py` 는 예외 → `(kind, reason, code, log_level, degraded, backoff_cycles)` 정책을 만든다. 이 `reason` 이 **프론트 계약의 발원지**다:

| 예외 | kind | reason (프론트 노출) |
|---|---|---|
| `KisTransportError` | `transport` | `kis_transport_error` |
| `KisRateLimitError` | `rate_limit` | `kis_rate_limit` |
| `KisAuthError` | `auth` | `kis_auth_error` |
| `KisApiError` | `kis_api` | `kis_api_error` |

기계 자체(백오프 사이클·degraded 플래그·로그 레벨 정책)는 벤더 무관이다. **#1011 의 에러 모델은 이 구조를 그대로 재사용할 수 있고, 그게 가장 싼 길이다** — 새로 설계하면 프론트 계약 4벌을 동시에 갈아야 한다.

### ⑤ 키움 모듈이 이미 KIS 타입에 의존한다

`hoga/live/kiwoom_index_candles.py` 가 `hoga.live.kis_models.IndexCandlePoint` 를 import 한다. ADR-0129 지수 분봉 이관의 잔재다.

두 가지를 뜻한다:
- **이관의 선례가 이미 존재한다** — 키움 구현이 KIS 모델을 재사용하는 형태로 착지했다.
- **함정 ①의 이사가 다른 모든 이관보다 먼저** 와야 한다. 그러지 않으면 이관할 때마다 키움 모듈이 KIS 파일을 import 하는 부채가 늘어난다.

### ⑥ ADR 불변식 봉인은 함정이 아니다 — 이미 방어돼 있다

`tests/unit/live/test_adr_invariants.py:52-53` 이 `hoga/live/kis_client.py` 와 `hoga/live/kis_models.py` 를 핫패스 모듈 목록(`_HOT_PATH_MODULES`)에 **파일 경로 문자열로** 못 박고 있다. 파일을 옮기면 검사가 조용히 비지 않을까 의심했으나, **아니다.** `:263-268` 에 이미 방어가 있다:

> "아래 가드는 원래 파일이 없으면 `pytest.skip` 했다. 모듈을 리네임·이동하면 …"
> `assert Path(module_path).exists(), f"{module_path} 가 없다. 리네임·이동했다면 _HOT_PATH_MODULES 를 함께 고쳐라 — "`

즉 **파일을 옮기면 명시적 메시지와 함께 시끄럽게 실패한다.** 삭제 PR 은 이 목록을 함께 고치면 되고, 잊으면 CI 가 잡는다. (`_PARQUET_CLOSURE_BASELINE` 도 함께 확인할 것 — baseline 항목이 사라지면 그 역시 갱신 대상.)

### ⑦ 프론트에 브라우저 영속 상태가 있다

`frontend/src/state/kisRestMode.ts` 가 localStorage 키 **두 개**를 소유한다:
- `chart.kisRestMode.v1`
- `chart.kisRestMode.v1.migrated` (legacy 마이그레이션 완료 플래그)

코드를 지우면 사용자 브라우저에 고아 키가 남는다. 다만 같은 파일에 `readLegacyKisRestBypass()` 라는 **legacy 키를 흡수하는 선례**가 이미 있으므로, 같은 문법으로 정리 경로를 쓸 수 있다.

---

## 4. 테스트 영향

### 삭제 가능 (KIS 전용 20파일 / 5,317줄 / 218 테스트)

```
tests/api/test_screener_kis_adapter.py
tests/unit/api/test_kis_api_orderflow_gate.py   test_kis_holidays.py   test_kis_master.py
tests/unit/live/test_kis_account_pool.py        test_kis_capacity_runtime.py
                test_kis_capacity_scheduler.py  test_kis_client.py
                test_kis_daily_adjust_flag.py   test_kis_index_parsers.py
                test_kis_multi_price.py         test_kis_rest_bypass_access.py
                test_kis_rest_methods.py        test_kis_runtime_accounts.py
                test_kis_singleton.py           test_kis_token_provider.py
                test_kis_venue.py               test_kis_walkback_helpers.py
tests/unit/live/test_api_kis_rest_bypass_candles.py   test_api_kis_rest_bypass_quotes.py
```

**전량 삭제가 아니다** — 최소 3개는 이사 대상이다:
- `test_kis_venue.py` — venue 타입·정책·세션창 로직은 함정 ②로 살아남는다
- `test_kis_holidays.py` / `test_kis_master.py` — #1013·#1014 판정에 후행

### 대수정 (간접 75파일)

핵심은 함정 ③의 시임이다. `kis_access.run_with_capacity` 를 몽키패치하는 파일이 재배선의 중심이고, `tests/conftest.py`·`tests/unit/live/conftest.py`·`tests/unit/api/conftest.py` 가 공통 픽스처를 쥐고 있다.

### 프론트 (테스트 63파일이 KIS 참조)

- **전용 삭제**: `live/KisRestUnavailableToastHost.test.tsx`, `state/kisRestMode.test.ts`
- **계약 수정**: `api/liveStatus.test.tsx`(kis_calls_today 등 3필드 봉인), `api/liveSettings.test.ts`(토글 패치 봉인), `live/LiveStateBanner.test.tsx`, `live/settings/DataSourceDetail.test.tsx`
- **e2e**: `frontend/tests/e2e/helpers/liveMocks.ts`, `live-smoke.spec.ts`

---

## 5. 사용자·관리자에게 노출된 KIS 문자열 전수

### 백엔드 에러 코드 (`hoga/api/error_codes.py`)

| 코드 | 처분 |
|---|---|
| `kis_holiday_fetch_failed` (`:72`) | #1013 갭 판정 후행 |
| `kis_credentials_missing` (`:76`) | 키움 문구로 대체 |
| `kis_master_fetch_failed` (`:89`) | #1014 마스터 판정 후행 |
| `kis_rest_bypassed_intraday_overlay_skipped` (`screener_intraday.py:74`, `screener_runner.py:52`) | 토글 소멸과 함께 제거 |

### 백엔드 API·관측 계약

| 필드 | 위치 |
|---|---|
| `kis_calls_today` | `hoga/live/lifecycle.py:53`, `:272` |
| `kis_rate_limit_remaining` | `hoga/live/lifecycle.py:54`, `:273` |
| `kis_rest_bypass_enabled` | `hoga/api/models.py:993`, `:1008` / `hoga/live/lifecycle.py:73` / `hoga/live/settings.py:47` |

`kis_rest_bypass_enabled` 는 **디스크 영속 설정**(live settings JSON)이기도 하다 — 기존 설정 파일에 남은 키 처리 필요.

### 프론트 사용자 노출

| 표면 | 위치 |
|---|---|
| 배너 **"KIS 자격증명이 설정되지 않았습니다"** (severity `error`, `/settings` 액션) | `live/LiveStateBanner.tsx:12`, `:29`; 투영은 `live/liveStatusProjection.ts:110` |
| KIS REST 불가 토스트 호스트 **(컴포넌트 전체)** | `live/KisRestUnavailableToastHost.tsx` |
| 설정 패널 **"KIS API 우회"** 토글 + 3중 소스 설명문 | `live/settings/DataSourceDetail.tsx:47`, `:62`, `:74`, `:107` |
| localStorage 2키 | `state/kisRestMode.ts` |

### 프론트 `reason` 유니온 4곳 — 이관 체크리스트로 쓸 것

```
api/livePastDailyCandles.ts:22   'kis_rate_limit' | 'kis_api_error' | 'invariant_violation' | 'kis_rest_bypassed'
api/liveIndices.ts:42            'kis_rate_limit' | 'kis_api_error' | 'invariant_violation' | 'index_minute_depth_limited'
api/livePastInvestorNet.ts:12    'kis_rate_limit' | 'kis_api_error' | 'invariant_violation'
api/liveInvestorTrendEstimate.ts:15  'kis_credentials_missing' | 'kis_rate_limit' | 'kis_api_error' | 'parse_error'
```

유니온이 문구 `Record` 와 결합돼 있어 **KIS 값을 지우면 누락 문구가 컴파일 에러로 잡힌다.** 이관 누락 방지 장치가 이미 타입 시스템에 있다.

### 설정·문서

- `.env.example` / `README.md` / `CLAUDE.md`: KIS 언급 **20건** (`KIS_APP_KEY`·`KIS_APP_SECRET`·dev 무자격 관례·거래일 조회 절)
- `docs/adr/`: KIS 를 언급하는 문서 **56개**. 전량 개정 대상이 아니라 **supersede 관계만 [#1016](https://github.com/Soochol/hoga-ops/issues/1016) 에서 명시**하면 된다.

---

## 6. 삭제 PR 이 후행해야 하는 결정

| 선행 티켓 | 무엇을 잠그는가 |
|---|---|
| [#1011](https://github.com/Soochol/hoga-ops/issues/1011) | B 분류 1,279줄의 대체물 + **테스트 시임**(함정 ③) + 에러 모델(함정 ④) |
| [#1012](https://github.com/Soochol/hoga-ops/issues/1012) | 분봉·일봉 경로가 남을지 |
| [#1013](https://github.com/Soochol/hoga-ops/issues/1013) | `kis_holidays.py` 처분 |
| [#1014](https://github.com/Soochol/hoga-ops/issues/1014) | `kis_master.py` 처분 |
| [#1016](https://github.com/Soochol/hoga-ops/issues/1016) | PR 분할·ADR supersede |

**단 C 분류(이사·리네임 152줄)는 어느 결정에도 후행하지 않는다.** `KisCandle`·`IndexCandlePoint`·`KisVenue`·`KIS_KST` 를 브로커 중립 위치로 옮기는 것은 지금 당장 가능하고, 함정 ⑤가 보여주듯 **먼저 할수록 이후 이관이 싸진다.** → 후속 티켓 후보.
